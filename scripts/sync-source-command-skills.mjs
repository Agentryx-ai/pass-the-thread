#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(SCRIPT_ROOT, "assets", "source-command-skills");
const BACKUP_DIRECTORY = ".threadpass-source-command-skill-backups";
const LOCK_DIRECTORY = ".threadpass-source-command-skill-sync.lock";
const SCHEMA = "threadpass.source-command-skill-sync/v3";
const LEGACY_SCHEMA_V2 = "threadpass.source-command-skill-sync/v2";
const LOCK_SCHEMA = "threadpass.source-command-skill-lock/v2";
const COMPLETE_SCHEMA = "threadpass.source-command-skill-complete/v1";
const ROLLBACK_INTENT_SCHEMA = "threadpass.source-command-skill-rollback-intent/v1";
const ROLLBACK_COMPLETE_SCHEMA = "threadpass.source-command-skill-rollback-complete/v1";
const ARTIFACT_TEMP_INFIX = ".threadpass-tmp-";
const MAPPINGS = Object.freeze([
  "source-command-save-session/SKILL.md",
  "source-command-resume-session/SKILL.md",
]);

try {
  const options = parseArgs(process.argv.slice(2));
  const targetRoot = safeTargetRoot(options.targetRoot, options.hasTargetOverride);
  const result = options.mode === "check"
    ? check(targetRoot)
    : withTargetLock(targetRoot, options.mode, options.hasTargetOverride, () => options.mode === "apply"
      ? apply(targetRoot, options.hasTargetOverride)
      : rollback(targetRoot, options.operationId, options.hasTargetOverride));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "mismatch") process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "rejected", reason: message(error) })}\n`);
  process.exitCode = 1;
}

function check(targetRoot) {
  const state = loadState(targetRoot);
  const mappings = state.map((entry) => ({
    relativePath: entry.relativePath,
    sourceSha256: entry.afterSha256,
    targetSha256: entry.beforeSha256,
    equal: entry.beforeSha256 === entry.afterSha256,
  }));
  return { mode: "check", status: mappings.every((entry) => entry.equal) ? "equal" : "mismatch", targetRoot, mappings };
}

function apply(targetRoot, testRoot) {
  const sources = loadSources();
  quarantineUnpublishedOperations(targetRoot);
  const pending = findPendingOperation(targetRoot);
  const hook = testHook(testRoot);
  if (pending) {
    validateOperation(pending, sources);
    convergeApply(pending, sources, hook);
    return { mode: "apply", status: "recovered", operationId: pending.manifest.operationId, targetRoot };
  }
  const state = loadState(targetRoot, sources);
  if (state.every((entry) => entry.beforeSha256 === entry.afterSha256)) {
    return { mode: "apply", status: "up-to-date", operationId: null, targetRoot };
  }
  const operation = prepareOperation(targetRoot, state, hook);
  interrupt(hook, "after-prepared");
  convergeApply(operation, sources, hook);
  return { mode: "apply", status: "applied", operationId: operation.manifest.operationId, targetRoot };
}

function rollback(targetRoot, operationId, testRoot) {
  if (!/^[a-zA-Z0-9._-]+$/.test(operationId)) throw new Error("rollback operation id is outside the allowlist");
  const operation = loadOperation(targetRoot, operationId);
  validateOperation(operation, loadSources(), false);
  const applyCompletePath = path.join(operation.root, "complete.json");
  if (!fs.existsSync(applyCompletePath)) throw new Error("cannot rollback an incomplete apply operation");
  validateApplyCompleteMarker(operation);
  const completePath = path.join(operation.root, "rollback-complete.json");
  if (fs.existsSync(completePath)) {
    reconcileExistingArtifact(completePath, rollbackCompletionBytes(operation.manifest.operationId), "rollback complete marker");
    assertAllTargets(operation, "beforeSha256", "completed rollback target mismatch");
    return { mode: "rollback", status: "already-rolled-back", operationId, targetRoot };
  }

  const intentPath = path.join(operation.root, "rollback-intent.json");
  const recovering = fs.existsSync(intentPath);
  if (recovering) reconcileExistingArtifact(intentPath, rollbackIntentBytes(operation.manifest.operationId), "rollback intent marker");
  validateRollbackStates(operation);
  const hook = testHook(testRoot);
  prepareRollbackStages(operation, hook);
  writeAtomicArtifact(intentPath, rollbackIntentBytes(operation.manifest.operationId), {
    hook,
    hookLabel: "rollback-intent",
    allowPartialRecovery: !recovering,
  });
  interrupt(hook, "rollback-after-prepared");
  convergeRollback(operation, hook);
  return { mode: "rollback", status: recovering ? "recovered" : "rolled-back", operationId, targetRoot };
}

function convergeApply(operation, sources, hook) {
  for (const [index, mapping] of operation.manifest.mappings.entries()) {
    if (mapping.beforeSha256 === mapping.afterSha256) continue;
    const paths = mappingPaths(operation.targetRoot, operation.manifest.operationId, mapping.relativePath, "apply");
    let targetHash = hashIfFile(paths.target, operation.targetRoot);
    let movedHash = hashIfFile(paths.moved, operation.targetRoot);
    let stageHash = hashIfFile(paths.stage, operation.targetRoot);
    if (stageHash === null && targetHash !== mapping.afterSha256) {
      const publicationNotStarted = targetHash === mapping.beforeSha256 && movedHash === null;
      writeAtomicArtifact(paths.stage, sources[index].bytes, {
        hook,
        hookLabel: `stage-${index + 1}`,
        allowPartialRecovery: publicationNotStarted,
      });
      stageHash = hashIfFile(paths.stage, operation.targetRoot);
    }
    if (stageHash !== null && stageHash !== mapping.afterSha256) throw new Error(`apply stage hash mismatch: ${mapping.relativePath}`);

    if (targetHash === mapping.beforeSha256 && movedHash === null) {
      fs.renameSync(paths.target, paths.moved);
      fsyncDirectory(path.dirname(paths.target));
      movedHash = hashIfFile(paths.moved, operation.targetRoot);
      if (movedHash !== mapping.beforeSha256) {
        if (!fs.existsSync(paths.target)) {
          try {
            restoreVerifiedMovedNoReplace(paths.moved, paths.target, mapping.beforeSha256, operation.targetRoot, `apply move-aside: ${mapping.relativePath}`);
          } catch { /* invalid moved evidence remains preserved for manual review */ }
        }
        throw new Error(`move-aside CAS mismatch: ${mapping.relativePath}`);
      }
      targetHash = null;
      interrupt(hook, `after-move-${index + 1}`);
    }
    if (targetHash === mapping.afterSha256 && movedHash === mapping.beforeSha256 && stageHash === mapping.afterSha256) {
      validateRecoveredPublicationEvidence(
        paths,
        mapping.afterSha256,
        operation.targetRoot,
        `recovered apply: ${mapping.relativePath}`,
      );
      continue;
    }
    if (targetHash === null && movedHash === mapping.beforeSha256 && stageHash === mapping.afterSha256) {
      interrupt(hook, `before-publish-${index + 1}`);
      publishValidatedStage(paths, {
        expectedStageSha256: mapping.afterSha256,
        expectedMovedSha256: mapping.beforeSha256,
        targetRoot: operation.targetRoot,
        hook,
        faultPrefix: "apply",
        index: index + 1,
        label: `apply publication: ${mapping.relativePath}`,
      });
      targetHash = hashIfFile(paths.target, operation.targetRoot);
      if (targetHash !== mapping.afterSha256) throw new Error(`publish verification failed: ${mapping.relativePath}`);
      interrupt(hook, `after-link-${index + 1}`);
      interrupt(hook, `after-publish-${index + 1}`);
    }
    if (targetHash !== mapping.afterSha256 || movedHash !== mapping.beforeSha256 || stageHash !== mapping.afterSha256) {
      throw new Error(`unrecognized apply journal state: ${mapping.relativePath}`);
    }
  }
  interrupt(hook, "after-all-published");
  writeAtomicArtifact(
    path.join(operation.root, "complete.json"),
    completionBytes(operation.manifest.operationId),
    { hook, hookLabel: "complete", allowPartialRecovery: false },
  );
  assertAllTargets(operation, "afterSha256", "completed apply target mismatch");
  discardApplyJournalArtifacts(operation);
}

function discardApplyJournalArtifacts(operation) {
  for (const mapping of operation.manifest.mappings) {
    if (mapping.beforeSha256 === mapping.afterSha256) continue;
    const paths = mappingPaths(operation.targetRoot, operation.manifest.operationId, mapping.relativePath, "apply");
    for (const artifact of [paths.stage, paths.publication, paths.moved]) {
      try { fs.unlinkSync(artifact); } catch { /* a verified apply never fails on journal cleanup */ }
    }
    try { fsyncDirectory(path.dirname(paths.target)); } catch { /* durability is best effort once the apply is verified */ }
  }
}

function convergeRollback(operation, hook) {
  validateRollbackStates(operation);
  for (const [index, mapping] of operation.manifest.mappings.entries()) {
    if (mapping.beforeSha256 === mapping.afterSha256) continue;
    const paths = mappingPaths(operation.targetRoot, operation.manifest.operationId, mapping.relativePath, "rollback");
    let targetHash = hashIfFile(paths.target, operation.targetRoot);
    let movedHash = hashIfFile(paths.moved, operation.targetRoot);
    let stageHash = hashIfFile(paths.stage, operation.targetRoot);
    if (targetHash === mapping.beforeSha256 && movedHash === mapping.afterSha256 && stageHash === mapping.beforeSha256) {
      validateRecoveredPublicationEvidence(
        paths,
        mapping.beforeSha256,
        operation.targetRoot,
        `recovered rollback: ${mapping.relativePath}`,
      );
      continue;
    }
    if (targetHash === mapping.beforeSha256 && movedHash === null && stageHash === null) continue;
    if (targetHash === mapping.afterSha256 && movedHash === null) {
      if (stageHash !== mapping.beforeSha256) throw new Error(`rollback stage hash mismatch: ${mapping.relativePath}`);
      fs.renameSync(paths.target, paths.moved);
      fsyncDirectory(path.dirname(paths.target));
      movedHash = hashIfFile(paths.moved, operation.targetRoot);
      if (movedHash !== mapping.afterSha256) {
        if (!fs.existsSync(paths.target)) {
          try {
            restoreVerifiedMovedNoReplace(paths.moved, paths.target, mapping.afterSha256, operation.targetRoot, `rollback move-aside: ${mapping.relativePath}`);
          } catch { /* invalid moved evidence remains preserved for manual review */ }
        }
        throw new Error(`rollback move-aside CAS mismatch: ${mapping.relativePath}`);
      }
      targetHash = null;
      interrupt(hook, `rollback-after-move-${index + 1}`);
    }
    if (targetHash === null && movedHash === mapping.afterSha256 && stageHash === mapping.beforeSha256) {
      interrupt(hook, `rollback-before-publish-${index + 1}`);
      publishValidatedStage(paths, {
        expectedStageSha256: mapping.beforeSha256,
        expectedMovedSha256: mapping.afterSha256,
        targetRoot: operation.targetRoot,
        hook,
        faultPrefix: "rollback",
        index: index + 1,
        label: `rollback publication: ${mapping.relativePath}`,
      });
      targetHash = hashIfFile(paths.target, operation.targetRoot);
      if (targetHash !== mapping.beforeSha256) throw new Error(`rollback publish verification failed: ${mapping.relativePath}`);
      interrupt(hook, `rollback-after-link-${index + 1}`);
      interrupt(hook, `rollback-after-publish-${index + 1}`);
    }
    if (targetHash !== mapping.beforeSha256 || movedHash !== mapping.afterSha256 || stageHash !== mapping.beforeSha256) {
      throw new Error(`unrecognized rollback journal state: ${mapping.relativePath}`);
    }
  }
  interrupt(hook, "rollback-after-all-published");
  writeAtomicArtifact(
    path.join(operation.root, "rollback-complete.json"),
    rollbackCompletionBytes(operation.manifest.operationId),
    { hook, hookLabel: "rollback-complete", allowPartialRecovery: false },
  );
  assertAllTargets(operation, "beforeSha256", "completed rollback target mismatch");
}

function prepareOperation(targetRoot, state, hook) {
  const backupRoot = path.join(targetRoot, BACKUP_DIRECTORY);
  ensureSafeDirectory(backupRoot, targetRoot);
  const operationId = `sync-${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}-${randomBytes(5).toString("hex")}`;
  const root = path.join(backupRoot, operationId);
  fs.mkdirSync(root);
  assertSafeDirectory(root, backupRoot, true);
  const mappings = state.map((entry) => ({
    relativePath: entry.relativePath,
    beforeSha256: entry.beforeSha256,
    afterSha256: entry.afterSha256,
    backupRelativePath: path.posix.join("preimages", entry.relativePath),
  }));
  for (const [index, mapping] of mappings.entries()) {
    const backupPath = operationDestination(root, mapping.backupRelativePath);
    writeAtomicArtifact(backupPath, state[index].beforeBytes, {
      hook,
      hookLabel: `backup-${index + 1}`,
      allowPartialRecovery: true,
    });
    if (sha256(fs.readFileSync(backupPath)) !== mapping.beforeSha256) throw new Error(`preimage backup verification failed: ${mapping.relativePath}`);
  }
  const manifest = { schema: SCHEMA, operationId, createdAt: new Date().toISOString(), targetRoot, mappings };
  writeAtomicArtifact(path.join(root, "manifest.json"), manifestBytes(manifest), {
    hook,
    hookLabel: "manifest",
    allowPartialRecovery: true,
  });
  const operation = { root, targetRoot, manifest };
  for (const [index, mapping] of mappings.entries()) {
    if (mapping.beforeSha256 === mapping.afterSha256) continue;
    writeAtomicArtifact(mappingPaths(targetRoot, operationId, mapping.relativePath, "apply").stage, state[index].afterBytes, {
      hook,
      hookLabel: `stage-${index + 1}`,
      allowPartialRecovery: true,
    });
  }
  return operation;
}

function prepareRollbackStages(operation, hook) {
  for (const [index, mapping] of operation.manifest.mappings.entries()) {
    if (mapping.beforeSha256 === mapping.afterSha256) continue;
    const paths = mappingPaths(operation.targetRoot, operation.manifest.operationId, mapping.relativePath, "rollback");
    const targetHash = hashIfFile(paths.target, operation.targetRoot);
    if (targetHash === mapping.beforeSha256) continue;
    const backup = fs.readFileSync(operationFile(operation.root, mapping.backupRelativePath));
    const movedHash = hashIfFile(paths.moved, operation.targetRoot);
    writeAtomicArtifact(paths.stage, backup, {
      hook,
      hookLabel: `rollback-stage-${index + 1}`,
      allowPartialRecovery: targetHash === mapping.afterSha256 && movedHash === null,
    });
    if (hashIfFile(paths.stage, operation.targetRoot) !== mapping.beforeSha256) {
      throw new Error(`rollback stage hash mismatch: ${mapping.relativePath}`);
    }
  }
}

function validateRollbackStates(operation) {
  for (const mapping of operation.manifest.mappings) {
    if (mapping.beforeSha256 === mapping.afterSha256) continue;
    const paths = mappingPaths(operation.targetRoot, operation.manifest.operationId, mapping.relativePath, "rollback");
    const target = hashIfFile(paths.target, operation.targetRoot);
    const moved = hashIfFile(paths.moved, operation.targetRoot);
    const stage = hashIfFile(paths.stage, operation.targetRoot);
    if (stage !== null) {
      reconcileExistingArtifact(paths.stage, fs.readFileSync(paths.stage), `rollback stage: ${mapping.relativePath}`);
      if (hashIfFile(paths.stage, operation.targetRoot) !== mapping.beforeSha256) {
        throw new Error(`rollback stage changed during validation: ${mapping.relativePath}`);
      }
    }
    const valid = (target === mapping.afterSha256 && moved === null && (stage === null || stage === mapping.beforeSha256))
      || (target === null && moved === mapping.afterSha256 && stage === mapping.beforeSha256)
      || (target === mapping.beforeSha256 && moved === mapping.afterSha256 && (stage === null || stage === mapping.beforeSha256))
      || (target === mapping.beforeSha256 && moved === null && (stage === null || stage === mapping.beforeSha256));
    if (!valid) throw new Error(`rollback refused because live target was edited or journal state is invalid: ${mapping.relativePath}`);
  }
}

function findPendingOperation(targetRoot) {
  const backupRoot = path.join(targetRoot, BACKUP_DIRECTORY);
  if (!fs.existsSync(backupRoot)) return null;
  assertSafeDirectory(backupRoot, targetRoot, true);
  const pending = [];
  for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = path.join(backupRoot, entry.name);
    const manifestPath = path.join(root, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (raw?.schema !== SCHEMA && raw?.schema !== LEGACY_SCHEMA_V2) continue;
    const operation = loadOperation(targetRoot, entry.name);
    const completePath = path.join(root, "complete.json");
    if (fs.existsSync(completePath)) {
      validateApplyCompleteMarker(operation);
      continue;
    }
    if (raw.schema === LEGACY_SCHEMA_V2) {
      throw new Error(`incomplete legacy v2 operation requires manual evidence review: ${entry.name}`);
    }
    pending.push(operation);
  }
  if (pending.length > 1) throw new Error("multiple incomplete sync operations require manual review");
  return pending[0] ?? null;
}

function loadOperation(targetRoot, operationId) {
  const backupRoot = path.join(targetRoot, BACKUP_DIRECTORY);
  assertSafeDirectory(backupRoot, targetRoot, true);
  const root = path.join(backupRoot, operationId);
  assertDirectChild(root, backupRoot);
  assertSafeDirectory(root, backupRoot, true);
  const manifestPath = operationFile(root, "manifest.json");
  const manifestRaw = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  if (![SCHEMA, LEGACY_SCHEMA_V2].includes(manifest?.schema) || manifest.operationId !== operationId || pathKey(manifest.targetRoot) !== pathKey(targetRoot)
    || !sameMappingList(manifest.mappings)
    || !hasExactKeys(manifest, ["createdAt", "mappings", "operationId", "schema", "targetRoot"])
    || !manifestRaw.equals(manifestBytes(manifest))) throw new Error("invalid or noncanonical sync operation manifest");
  reconcileExistingArtifact(manifestPath, manifestRaw, "sync operation manifest");
  return { root, targetRoot, manifest };
}

function quarantineUnpublishedOperations(targetRoot) {
  const backupRoot = path.join(targetRoot, BACKUP_DIRECTORY);
  if (!fs.existsSync(backupRoot)) return;
  assertSafeDirectory(backupRoot, targetRoot, true);
  for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^sync-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
    const root = path.join(backupRoot, entry.name);
    if (fs.existsSync(path.join(root, "manifest.json"))) continue;
    const publicationAbsent = MAPPINGS.every((relativePath) => {
      const paths = mappingPaths(targetRoot, entry.name, relativePath, "apply");
      return fs.existsSync(paths.target) && !fs.existsSync(paths.moved);
    });
    if (!publicationAbsent) {
      throw new Error(`incomplete manifest requires recoverable manual evidence review: ${entry.name}`);
    }
    const quarantine = `${root}.quarantine-${Date.now()}-${randomBytes(4).toString("hex")}`;
    fs.renameSync(root, quarantine);
    fsyncDirectory(backupRoot);
  }
}

function validateOperation(operation, sources, requireCurrentSources = true) {
  for (const [index, mapping] of operation.manifest.mappings.entries()) {
    const backupPath = operationFile(operation.root, mapping.backupRelativePath);
    const backup = fs.readFileSync(backupPath);
    if (sha256(backup) !== mapping.beforeSha256) throw new Error(`backup hash mismatch: ${mapping.relativePath}`);
    reconcileExistingArtifact(backupPath, backup, `preimage backup: ${mapping.relativePath}`);
    if (requireCurrentSources && sources[index].sha256 !== mapping.afterSha256) {
      throw new Error(`pending operation source changed and requires manual review: ${mapping.relativePath}`);
    }
    const paths = mappingPaths(operation.targetRoot, operation.manifest.operationId, mapping.relativePath, "apply");
    const stage = hashIfFile(paths.stage, operation.targetRoot);
    const moved = hashIfFile(paths.moved, operation.targetRoot);
    if (stage !== null && stage !== mapping.afterSha256) throw new Error(`apply stage hash mismatch: ${mapping.relativePath}`);
    if (stage !== null) {
      reconcileExistingArtifact(paths.stage, fs.readFileSync(paths.stage), `apply stage: ${mapping.relativePath}`);
      if (hashIfFile(paths.stage, operation.targetRoot) !== mapping.afterSha256) {
        throw new Error(`apply stage changed during validation: ${mapping.relativePath}`);
      }
    }
    if (moved !== null && moved !== mapping.beforeSha256) throw new Error(`apply moved-aside hash mismatch: ${mapping.relativePath}`);
  }
}

function loadSources() {
  return MAPPINGS.map((relativePath) => {
    const sourcePath = mappedSource(relativePath);
    const bytes = fs.readFileSync(sourcePath);
    return { relativePath, sourcePath, bytes, sha256: sha256(bytes) };
  });
}

function loadState(targetRoot, sources = loadSources()) {
  return MAPPINGS.map((relativePath, index) => {
    const targetPath = mappedTarget(targetRoot, relativePath, true);
    const beforeBytes = fs.readFileSync(targetPath);
    return {
      relativePath,
      targetPath,
      targetRoot,
      beforeBytes,
      afterBytes: sources[index].bytes,
      beforeSha256: sha256(beforeBytes),
      afterSha256: sources[index].sha256,
    };
  });
}

function mappingPaths(targetRoot, operationId, relativePath, direction) {
  const target = mappedTarget(targetRoot, relativePath, false);
  const suffix = `.threadpass-${operationId}.${direction}`;
  return {
    target,
    stage: `${target}${suffix}.stage`,
    publication: `${target}${suffix}.publication`,
    moved: `${target}${suffix}.moved`,
  };
}

function mappedSource(relativePath) {
  if (!MAPPINGS.includes(relativePath)) throw new Error("source mapping is outside the allowlist");
  const result = path.join(SOURCE_ROOT, relativePath);
  assertDirectDescendant(result, SOURCE_ROOT);
  assertSafeRegularFile(result, SOURCE_ROOT);
  return fs.realpathSync.native(result);
}

function mappedTarget(targetRoot, relativePath, mustExist) {
  if (!MAPPINGS.includes(relativePath)) throw new Error("target mapping is outside the allowlist");
  const result = path.join(targetRoot, relativePath);
  assertDirectDescendant(result, targetRoot);
  assertSafeDirectory(path.dirname(result), targetRoot, true);
  if (fs.existsSync(result)) assertSafeRegularFile(result, targetRoot);
  else if (mustExist) throw new Error(`target file does not exist: ${result}`);
  return result;
}

function hashIfFile(filePath, allowedRoot) {
  assertDirectDescendant(filePath, allowedRoot);
  assertSafeDirectory(path.dirname(filePath), allowedRoot, true);
  if (!fs.existsSync(filePath)) return null;
  assertSafeRegularFile(filePath, allowedRoot);
  return sha256(fs.readFileSync(filePath));
}

function assertAllTargets(operation, field, label) {
  for (const mapping of operation.manifest.mappings) {
    const target = mappedTarget(operation.targetRoot, mapping.relativePath, true);
    if (sha256(fs.readFileSync(target)) !== mapping[field]) throw new Error(`${label}: ${mapping.relativePath}`);
  }
}

function operationDestination(root, relativePath) {
  const result = path.join(root, relativePath);
  assertDirectDescendant(result, root);
  ensureSafeDirectory(path.dirname(result), root);
  return result;
}

function operationFile(root, relativePath) {
  const result = path.join(root, relativePath);
  assertDirectDescendant(result, root);
  assertSafeRegularFile(result, root);
  return fs.realpathSync.native(result);
}

function safeTargetRoot(input, override) {
  if (override && process.env.THREADPASS_SKILL_SYNC_TEST_ROOT !== "1") {
    throw new Error("--target-root is available only with THREADPASS_SKILL_SYNC_TEST_ROOT=1");
  }
  const resolved = path.resolve(input ?? path.join(os.homedir(), ".agents", "skills"));
  assertOneDirectory(resolved);
  const canonical = fs.realpathSync.native(resolved);
  if (override) {
    const temp = fs.realpathSync.native(os.tmpdir());
    assertDirectDescendant(canonical, temp);
  }
  return canonical;
}

function withTargetLock(targetRoot, mode, testRoot, action) {
  const lockRoot = path.join(targetRoot, LOCK_DIRECTORY);
  const hook = testHook(testRoot);
  const nonce = randomBytes(12).toString("hex");
  try {
    fs.mkdirSync(lockRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(canonicalLockReason(lockRoot));
    throw error;
  }
  fsyncDirectory(targetRoot);
  interrupt(hook, "lock-pre-owner");
  const owner = { schema: LOCK_SCHEMA, pid: process.pid, nonce, mode, createdAt: new Date().toISOString() };
  writeAtomicArtifact(path.join(lockRoot, "owner.json"), lockOwnerBytes(owner), {
    hook,
    hookLabel: "lock-owner",
    allowPartialRecovery: true,
  });
  fsyncDirectory(lockRoot);
  interrupt(hook, "lock-post-owner");
  interrupt(hook, "lock-post-publish");
  const acquired = readStableLockSnapshot(lockRoot);
  if (!acquired.owner
    || acquired.owner.nonce !== nonce
    || acquired.owner.pid !== process.pid
    || acquired.directoryIdentity === null
    || acquired.ownerIdentity === null) {
    throw new Error("target-root lock ownership changed immediately after acquisition");
  }
  try {
    return action();
  } finally {
    releaseLock(lockRoot, acquired, hook);
  }
}

function releaseLock(lockRoot, acquired, hook) {
  injectLockReleaseFault(hook, "lock-release-before-rename", lockRoot);
  const releaseRoot = `${lockRoot}.release-${process.pid}-${acquired.owner.nonce}-${randomBytes(6).toString("hex")}`;
  fs.renameSync(lockRoot, releaseRoot);
  fsyncDirectory(path.dirname(lockRoot));
  injectLockReleaseFault(hook, "lock-release-after-rename", lockRoot);

  const released = readStableLockSnapshot(releaseRoot);
  const ours = released.owner !== null
    && released.owner.nonce === acquired.owner.nonce
    && released.owner.pid === acquired.owner.pid
    && released.directoryIdentity !== null
    && released.ownerIdentity !== null
    && sameFileIdentity(released.directoryIdentity, acquired.directoryIdentity)
    && sameFileIdentity(released.ownerIdentity, acquired.ownerIdentity);
  if (ours) {
    try {
      fs.rmSync(releaseRoot, { recursive: true, force: true });
      fsyncDirectory(path.dirname(lockRoot));
    } catch { /* an already-released lock never fails on evidence cleanup */ }
    return;
  }

  if (!fs.existsSync(lockRoot)) restoreReleasedLockNoReplace(releaseRoot, lockRoot, released);
  throw new Error(`target-root lock ownership changed during release; preserved release evidence at ${releaseRoot}`);
}

function restoreReleasedLockNoReplace(releaseRoot, lockRoot, released) {
  const entries = fs.readdirSync(releaseRoot, { withFileTypes: true });
  if (!released.safe || released.owner === null || entries.length !== 1
    || entries[0].name !== "owner.json" || !entries[0].isFile() || entries[0].isSymbolicLink()) {
    throw new Error(`released lock cannot be restored automatically; preserved evidence at ${releaseRoot}`);
  }
  try {
    fs.mkdirSync(lockRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`replacement canonical lock blocked restoration; preserved release evidence at ${releaseRoot}`);
    }
    throw error;
  }
  fsyncDirectory(path.dirname(lockRoot));
  linkNoReplace(
    path.join(releaseRoot, "owner.json"),
    path.join(lockRoot, "owner.json"),
    `replacement canonical lock owner blocked restoration; preserved release evidence at ${releaseRoot}`,
  );
  fsyncDirectory(lockRoot);
  const restored = readStableLockSnapshot(lockRoot);
  if (restored.owner === null || !lockOwnerBytes(restored.owner).equals(lockOwnerBytes(released.owner))) {
    throw new Error(`restored canonical lock identity is invalid; preserved release evidence at ${releaseRoot}`);
  }
}

function canonicalLockReason(lockRoot) {
  const snapshot = readStableLockSnapshot(lockRoot);
  const ageBasis = snapshot.owner ? Date.parse(snapshot.owner.createdAt) : snapshot.directoryMtimeMs;
  const ageMs = Number.isFinite(ageBasis) ? Math.max(0, Date.now() - ageBasis) : "unknown";
  const owner = snapshot.owner
    ? `pid=${snapshot.owner.pid}, mode=${snapshot.owner.mode}, nonce=${snapshot.owner.nonce}`
    : `owner unavailable (${snapshot.fingerprint})`;
  return `target root lock exists at ${lockRoot}; ${owner}; ageMs=${ageMs}; automatic reclamation is disabled—coordinate manually and remove it only after proving no writer is active`;
}

function readStableLockSnapshot(lockRoot) {
  try {
    const directoryStat = fs.lstatSync(lockRoot, { bigint: true });
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return {
        owner: null,
        safe: false,
        directoryIdentity: null,
        ownerIdentity: null,
        directoryMtimeMs: Number(directoryStat.mtimeMs),
        fingerprint: `unsafe:${directoryStat.mtimeNs}`,
      };
    }
    const ownerPath = path.join(lockRoot, "owner.json");
    if (!fs.existsSync(ownerPath)) {
      return {
        owner: null,
        safe: true,
        directoryIdentity: fileIdentity(directoryStat),
        ownerIdentity: null,
        directoryMtimeMs: Number(directoryStat.mtimeMs),
        fingerprint: `missing:${directoryStat.mtimeNs}`,
      };
    }
    const ownerStat = fs.lstatSync(ownerPath, { bigint: true });
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
      return {
        owner: null,
        safe: false,
        directoryIdentity: fileIdentity(directoryStat),
        ownerIdentity: null,
        directoryMtimeMs: Number(directoryStat.mtimeMs),
        fingerprint: `unsafe-owner:${ownerStat.mtimeNs}`,
      };
    }
    const bytes = fs.readFileSync(ownerPath);
    let owner = null;
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (parsed?.schema === LOCK_SCHEMA
        && Number.isInteger(parsed.pid)
        && parsed.pid > 0
        && typeof parsed.nonce === "string"
        && typeof parsed.mode === "string"
        && typeof parsed.createdAt === "string"
        && hasExactKeys(parsed, ["createdAt", "mode", "nonce", "pid", "schema"])
        && bytes.equals(lockOwnerBytes(parsed))) owner = parsed;
    } catch { /* malformed owner remains null */ }
    return {
      owner,
      safe: true,
      directoryIdentity: fileIdentity(directoryStat),
      ownerIdentity: fileIdentity(ownerStat),
      directoryMtimeMs: Number(directoryStat.mtimeMs),
      fingerprint: `${directoryStat.mtimeNs}:${ownerStat.mtimeNs}:${ownerStat.size}:${sha256(bytes)}`,
    };
  } catch (error) {
    return {
      owner: null,
      safe: false,
      directoryIdentity: null,
      ownerIdentity: null,
      directoryMtimeMs: Date.now(),
      fingerprint: `unreadable:${message(error)}`,
    };
  }
}

function testHook(enabled) {
  const interruptAt = process.env.THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT ?? null;
  const faultAt = process.env.THREADPASS_SKILL_SYNC_TEST_FAULT_AT ?? null;
  const faultKind = process.env.THREADPASS_SKILL_SYNC_TEST_FAULT_KIND ?? null;
  const cleanupFaultAt = process.env.THREADPASS_SKILL_SYNC_TEST_CLEANUP_FAULT_AT ?? null;
  const cleanupFaultKind = process.env.THREADPASS_SKILL_SYNC_TEST_CLEANUP_FAULT_KIND ?? null;
  const releaseFaultAt = process.env.THREADPASS_SKILL_SYNC_TEST_RELEASE_FAULT_AT ?? null;
  const releaseFaultKind = process.env.THREADPASS_SKILL_SYNC_TEST_RELEASE_FAULT_KIND ?? null;
  if ((interruptAt !== null || faultAt !== null || faultKind !== null || cleanupFaultAt !== null || cleanupFaultKind !== null
    || releaseFaultAt !== null || releaseFaultKind !== null) && !enabled) {
    throw new Error("test hooks require a guarded --target-root");
  }
  if ((faultAt === null) !== (faultKind === null)) throw new Error("test publication fault requires both point and kind");
  if ((cleanupFaultAt === null) !== (cleanupFaultKind === null)) throw new Error("test cleanup fault requires both point and kind");
  if ((releaseFaultAt === null) !== (releaseFaultKind === null)) throw new Error("test lock-release fault requires both point and kind");
  return { interruptAt, faultAt, faultKind, cleanupFaultAt, cleanupFaultKind, releaseFaultAt, releaseFaultKind };
}

function interrupt(hook, point) {
  if (hook?.interruptAt === point) throw new Error(`injected interruption at ${point}`);
}

function injectLockReleaseFault(hook, point, lockRoot) {
  if (hook?.releaseFaultAt !== point) return;
  if (hook.releaseFaultKind !== "replace-lock-external") {
    throw new Error(`unknown injected lock-release fault: ${hook.releaseFaultKind}`);
  }
  if (point === "lock-release-before-rename") {
    const evidence = `${lockRoot}.injected-original-${randomBytes(4).toString("hex")}`;
    fs.renameSync(lockRoot, evidence);
  }
  fs.mkdirSync(lockRoot, { mode: 0o700 });
  const boundary = point.endsWith("after-rename") ? "after-rename" : "before-rename";
  const owner = {
    schema: LOCK_SCHEMA,
    pid: process.pid + 1,
    nonce: `external-${boundary}`,
    mode: "external",
    createdAt: new Date().toISOString(),
  };
  writeAtomicArtifact(path.join(lockRoot, "owner.json"), lockOwnerBytes(owner), {
    hook: null,
    hookLabel: "external-lock-owner",
    allowPartialRecovery: true,
  });
  fsyncDirectory(lockRoot);
  fsyncDirectory(path.dirname(lockRoot));
}

function writeAtomicArtifact(filePath, bytes, options) {
  const directory = path.dirname(filePath);
  assertSafeDirectory(directory, directory, true);
  const temps = artifactTemps(filePath);
  if (fs.existsSync(filePath)) {
    validateExactArtifact(filePath, bytes, "existing journal file");
    if (temps.some((tempPath) => !fs.readFileSync(tempPath).equals(bytes))) {
      throw new Error(`partial artifact requires recoverable evidence review: ${temps.join(", ")}`);
    }
    for (const tempPath of temps) fs.unlinkSync(tempPath);
    if (temps.length > 0) fsyncDirectory(directory);
    return;
  }
  if (temps.length > 0) {
    const allExact = temps.every((tempPath) => fs.readFileSync(tempPath).equals(bytes));
    if (allExact) {
      linkNoReplace(temps[0], filePath, `journal publication target already exists: ${filePath}`);
      fsyncDirectory(directory);
      validateExactArtifact(filePath, bytes, "published journal artifact");
      for (const tempPath of temps) fs.unlinkSync(tempPath);
      fsyncDirectory(directory);
      return;
    }
    if (!options.allowPartialRecovery) {
      throw new Error(`partial artifact requires recoverable evidence review: ${temps.join(", ")}`);
    }
    for (const tempPath of temps) quarantineArtifact(tempPath);
    fsyncDirectory(directory);
  }

  const tempPath = `${filePath}${ARTIFACT_TEMP_INFIX}${process.pid}-${randomBytes(8).toString("hex")}`;
  const descriptor = fs.openSync(tempPath, "wx", 0o600);
  try {
    const split = Math.max(1, Math.floor(bytes.length / 2));
    fs.writeFileSync(descriptor, bytes.subarray(0, split));
    fs.fsyncSync(descriptor);
    interrupt(options.hook, `${options.hookLabel}-after-partial`);
    fs.writeFileSync(descriptor, bytes.subarray(split));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  interrupt(options.hook, `${options.hookLabel}-after-temp`);
  linkNoReplace(tempPath, filePath, `journal publication target already exists: ${filePath}`);
  fsyncDirectory(directory);
  validateExactArtifact(filePath, bytes, "published journal artifact");
  fs.unlinkSync(tempPath);
  fsyncDirectory(directory);
}

function artifactTemps(filePath) {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}${ARTIFACT_TEMP_INFIX}`;
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`unsafe journal temp artifact: ${entry.name}`);
      return path.join(directory, entry.name);
    });
}

function quarantineArtifact(filePath) {
  const quarantine = path.join(
    path.dirname(filePath),
    `.threadpass-quarantine-${path.basename(filePath)}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  fs.renameSync(filePath, quarantine);
}

function linkNoReplace(sourcePath, targetPath, blockedMessage) {
  try {
    fs.linkSync(sourcePath, targetPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(blockedMessage);
    throw error;
  }
}

function publishValidatedStage(paths, options) {
  const validatedStage = openValidatedPublicationFile(
    paths.stage,
    options.targetRoot,
    options.expectedStageSha256,
    `${options.label} stage`,
  );
  writeAtomicArtifact(paths.publication, validatedStage.bytes, {
    hook: null,
    hookLabel: `${options.faultPrefix}-publication-${options.index}`,
    allowPartialRecovery: true,
  });
  const validatedPublication = openValidatedPublicationFile(
    paths.publication,
    options.targetRoot,
    options.expectedStageSha256,
    `${options.label} publication`,
  );
  let createdIdentity = null;
  try {
    injectPublicationFault(options.hook, `${options.faultPrefix}-before-link-${options.index}`, paths);
    linkNoReplace(paths.publication, paths.target, `external target blocked ${options.label}`);
    fsyncDirectory(path.dirname(paths.target));
    createdIdentity = linkedIdentity(paths.publication, paths.target, options.targetRoot);
    injectPublicationFault(options.hook, `${options.faultPrefix}-after-link-${options.index}`, paths);
    verifyBoundPublication(
      paths,
      validatedStage,
      validatedPublication,
      options.expectedStageSha256,
      options.targetRoot,
      options.label,
    );
  } catch (error) {
    const cleanup = recoverFailedPublication(
      paths,
      createdIdentity,
      options.expectedMovedSha256,
      options.targetRoot,
      options.label,
      options.hook,
      options.faultPrefix,
      options.index,
    );
    throw new Error(`${options.label} failed: ${message(error)}; ${cleanup}`);
  } finally {
    fs.closeSync(validatedPublication.descriptor);
    fs.closeSync(validatedStage.descriptor);
  }
}

function openValidatedPublicationFile(filePath, targetRoot, expectedSha256, label) {
  assertDirectDescendant(filePath, targetRoot);
  assertSafeRegularFile(filePath, targetRoot);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    const bytes = fs.readFileSync(descriptor);
    const actualSha256 = sha256(bytes);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!samePublicationSnapshot(before, after)) throw new Error(`${label} snapshot changed while hashing`);
    if (actualSha256 !== expectedSha256) throw new Error(`${label} hash mismatch`);
    return { descriptor, identity: fileIdentity(before), snapshot: before, bytes };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function validateRecoveredPublicationEvidence(paths, expectedSha256, targetRoot, label) {
  let stage = null;
  let publication = null;
  let target = null;
  try {
    stage = openValidatedPublicationFile(paths.stage, targetRoot, expectedSha256, `${label} stage`);
    publication = openValidatedPublicationFile(paths.publication, targetRoot, expectedSha256, `${label} publication`);
    target = openValidatedPublicationFile(paths.target, targetRoot, expectedSha256, `${label} target`);
    if (sameFileIdentity(stage.identity, publication.identity) || sameFileIdentity(stage.identity, target.identity)) {
      throw new Error("stage aliases the publication or live target inode");
    }
    if (!sameFileIdentity(publication.identity, target.identity)) {
      throw new Error("publication and live target do not share the published inode");
    }
    for (const [filePath, opened, evidenceLabel] of [
      [paths.stage, stage, "stage"],
      [paths.publication, publication, "publication"],
      [paths.target, target, "target"],
    ]) {
      const after = fs.fstatSync(opened.descriptor, { bigint: true });
      const currentIdentity = identityIfSafeFile(filePath, targetRoot);
      if (!samePublicationSnapshot(opened.snapshot, after)
        || currentIdentity === null
        || !sameFileIdentity(currentIdentity, opened.identity)) {
        throw new Error(`${evidenceLabel} path changed during recovered publication validation`);
      }
    }
  } catch (error) {
    throw new Error(`${label} publication evidence requires manual review: ${message(error)}`);
  } finally {
    if (target !== null) fs.closeSync(target.descriptor);
    if (publication !== null) fs.closeSync(publication.descriptor);
    if (stage !== null) fs.closeSync(stage.descriptor);
  }
}

function verifyBoundPublication(paths, validatedStage, validatedPublication, expectedSha256, targetRoot, label) {
  const stageIdentity = identityIfSafeFile(paths.stage, targetRoot);
  const publicationIdentity = identityIfSafeFile(paths.publication, targetRoot);
  const targetIdentity = identityIfSafeFile(paths.target, targetRoot);
  if (stageIdentity === null || publicationIdentity === null || targetIdentity === null
    || !sameFileIdentity(stageIdentity, validatedStage.identity)
    || !sameFileIdentity(publicationIdentity, validatedPublication.identity)
    || !sameFileIdentity(targetIdentity, validatedPublication.identity)) {
    throw new Error(`${label} stage/publication/target identity no longer matches the validated files`);
  }
  if (!samePublicationSnapshot(validatedStage.snapshot, fs.fstatSync(validatedStage.descriptor, { bigint: true }))) {
    throw new Error(`${label} stage snapshot changed after validation`);
  }
  const publicationAfter = fs.fstatSync(validatedPublication.descriptor, { bigint: true });
  if (!sameFileIdentity(fileIdentity(validatedPublication.snapshot), fileIdentity(publicationAfter))
    || validatedPublication.snapshot.size !== publicationAfter.size
    || validatedPublication.snapshot.mtimeNs !== publicationAfter.mtimeNs) {
    throw new Error(`${label} publication snapshot changed after validation`);
  }
  if (hashIfFile(paths.stage, targetRoot) !== expectedSha256) throw new Error(`${label} stage hash mismatch`);
  if (hashIfFile(paths.target, targetRoot) !== expectedSha256) throw new Error(`${label} target hash mismatch`);
}

function linkedIdentity(stagePath, targetPath, targetRoot) {
  const stageIdentity = identityIfSafeFile(stagePath, targetRoot);
  const targetIdentity = identityIfSafeFile(targetPath, targetRoot);
  return stageIdentity !== null && targetIdentity !== null && sameFileIdentity(stageIdentity, targetIdentity)
    ? targetIdentity
    : null;
}

function recoverFailedPublication(paths, createdIdentity, expectedMovedSha256, targetRoot, label, hook, faultPrefix, index) {
  let preservedCreatedTarget = false;
  if (createdIdentity !== null) {
    try {
      const claim = claimCleanupTarget(paths, createdIdentity, targetRoot, hook, faultPrefix, index, label);
      preservedCreatedTarget = claim.kind === "created-preserved";
      if (claim.kind === "external-preserved") {
        return `external target atomically claimed and preserved at ${claim.evidencePath}; moved preimage preserved`;
      }
    } catch (error) {
      return `cleanup claim refused with recoverable evidence: ${message(error)}; moved preimage preserved`;
    }
  }
  if (fs.existsSync(paths.target)) {
    return "target retained after atomic cleanup claim because it is absent from or no longer names this operation's created link; moved preimage preserved";
  }
  try {
    restoreVerifiedMovedNoReplace(paths.moved, paths.target, expectedMovedSha256, targetRoot, label);
    return `${preservedCreatedTarget ? "created target quarantined and " : ""}verified moved preimage restored`;
  } catch (error) {
    return `${preservedCreatedTarget ? "created target quarantined; " : ""}moved preimage preserved after restore refusal: ${message(error)}`;
  }
}

function restoreVerifiedMovedNoReplace(movedPath, targetPath, expectedSha256, targetRoot, label) {
  const validated = openValidatedPublicationFile(movedPath, targetRoot, expectedSha256, `${label} moved preimage`);
  let createdIdentity = null;
  try {
    linkNoReplace(movedPath, targetPath, `external target blocked ${label} moved-preimage restoration`);
    fsyncDirectory(path.dirname(targetPath));
    createdIdentity = linkedIdentity(movedPath, targetPath, targetRoot);
    if (createdIdentity === null || !sameFileIdentity(createdIdentity, validated.identity)) {
      throw new Error(`${label} restored target inode does not match the verified moved preimage`);
    }
    if (hashIfFile(targetPath, targetRoot) !== expectedSha256) throw new Error(`${label} restored target hash mismatch`);
  } catch (error) {
    if (createdIdentity !== null) {
      claimCleanupTarget(
        { target: targetPath, moved: movedPath },
        createdIdentity,
        targetRoot,
        null,
        "restore",
        0,
        `${label} restore cleanup`,
      );
    }
    throw error;
  } finally {
    fs.closeSync(validated.descriptor);
  }
}

function claimCleanupTarget(paths, createdIdentity, targetRoot, hook, faultPrefix, index, label) {
  const parent = path.dirname(paths.target);
  const claimRoot = `${paths.moved}.cleanup-claim-${randomBytes(8).toString("hex")}`;
  const claimedPath = path.join(claimRoot, "claimed-target");
  assertDirectDescendant(claimRoot, targetRoot);
  fs.mkdirSync(claimRoot, { mode: 0o700 });
  fsyncDirectory(parent);
  injectCleanupFault(hook, `${faultPrefix}-cleanup-before-claim-${index}`, paths);
  try {
    fs.renameSync(paths.target, claimedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { kind: "absent", evidencePath: claimRoot };
  }
  fsyncDirectory(parent);
  fsyncDirectory(claimRoot);
  injectCleanupFault(hook, `${faultPrefix}-cleanup-after-claim-${index}`, paths);

  const claimed = openPublicationIdentity(claimedPath, targetRoot);
  try {
    if (sameFileIdentity(claimed.identity, createdIdentity)) {
      return { kind: "created-preserved", evidencePath: claimedPath };
    }
  } finally {
    if (!claimed.closed) fs.closeSync(claimed.descriptor);
  }

  if (!fs.existsSync(paths.target)) {
    try {
      linkNoReplace(claimedPath, paths.target, `external target appeared while restoring cleanup claim for ${label}`);
      fsyncDirectory(parent);
      const restoredIdentity = identityIfSafeFile(paths.target, targetRoot);
      const evidenceIdentity = identityIfSafeFile(claimedPath, targetRoot);
      if (restoredIdentity === null || evidenceIdentity === null || !sameFileIdentity(restoredIdentity, evidenceIdentity)) {
        throw new Error(`external cleanup claim restoration identity mismatch for ${label}`);
      }
    } catch (error) {
      if (!fs.existsSync(paths.target)) throw error;
    }
  }
  return { kind: "external-preserved", evidencePath: claimedPath };
}

function openPublicationIdentity(filePath, targetRoot) {
  assertSafeRegularFile(filePath, targetRoot);
  const descriptor = fs.openSync(filePath, "r");
  const snapshot = fs.fstatSync(descriptor, { bigint: true });
  if (!snapshot.isFile()) {
    fs.closeSync(descriptor);
    throw new Error(`cleanup claim is not a regular file: ${filePath}`);
  }
  return { descriptor, identity: fileIdentity(snapshot), closed: false };
}

function identityIfSafeFile(filePath, targetRoot) {
  if (!fs.existsSync(filePath)) return null;
  assertSafeRegularFile(filePath, targetRoot);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const snapshot = fs.fstatSync(descriptor, { bigint: true });
    return snapshot.isFile() ? fileIdentity(snapshot) : null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function fileIdentity(snapshot) {
  return { dev: snapshot.dev, ino: snapshot.ino };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePublicationSnapshot(left, right) {
  return sameFileIdentity(fileIdentity(left), fileIdentity(right))
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function injectPublicationFault(hook, point, paths) {
  if (hook?.faultAt !== point) return;
  if (hook.faultKind === "mutate-stage") {
    fs.appendFileSync(paths.stage, "injected stage mutation\n");
  } else if (hook.faultKind === "swap-stage") {
    const evidence = `${paths.stage}.injected-original-${randomBytes(4).toString("hex")}`;
    fs.renameSync(paths.stage, evidence);
    fs.writeFileSync(paths.stage, "injected swapped stage bytes\n", { flag: "wx" });
  } else if (hook.faultKind === "replace-target-external") {
    fs.unlinkSync(paths.target);
    const direction = point.startsWith("rollback-") ? "rollback" : "apply";
    fs.writeFileSync(paths.target, `external ${direction} replacement\n`, { flag: "wx" });
  } else {
    throw new Error(`unknown injected publication fault: ${hook.faultKind}`);
  }
  fsyncDirectory(path.dirname(paths.target));
}

function injectCleanupFault(hook, point, paths) {
  if (hook?.cleanupFaultAt !== point) return;
  if (hook.cleanupFaultKind !== "replace-target-external") {
    throw new Error(`unknown injected cleanup fault: ${hook.cleanupFaultKind}`);
  }
  if (fs.existsSync(paths.target)) fs.unlinkSync(paths.target);
  const direction = point.startsWith("rollback-") ? "rollback" : "apply";
  const boundary = point.includes("after-claim") ? "after-claim" : "before-claim";
  fs.writeFileSync(paths.target, `external ${direction} cleanup ${boundary}\n`, { flag: "wx" });
  fsyncDirectory(path.dirname(paths.target));
}

function validateExactArtifact(filePath, expected, label) {
  assertSafeRegularFile(filePath, path.dirname(filePath));
  if (!fs.readFileSync(filePath).equals(expected)) throw new Error(`${label} is invalid or differs from its exact schema bytes: ${filePath}`);
}

function reconcileExistingArtifact(filePath, expected, label) {
  try {
    writeAtomicArtifact(filePath, expected, { hook: null, hookLabel: label, allowPartialRecovery: false });
  } catch (error) {
    throw new Error(`${label} reconciliation failed: ${message(error)}`);
  }
}

function validateApplyCompleteMarker(operation) {
  const completePath = path.join(operation.root, "complete.json");
  if (operation.manifest.schema === SCHEMA) {
    reconcileExistingArtifact(completePath, completionBytes(operation.manifest.operationId), "apply complete marker");
    return;
  }
  assertSafeRegularFile(completePath, operation.root);
  const bytes = fs.readFileSync(completePath);
  let marker;
  try { marker = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("legacy v2 apply complete marker is malformed"); }
  const completedAt = typeof marker.completedAt === "string" ? new Date(marker.completedAt) : null;
  if (!hasExactKeys(marker, ["completedAt"])
    || completedAt === null
    || !Number.isFinite(completedAt.getTime())
    || completedAt.toISOString() !== marker.completedAt
    || !bytes.equals(Buffer.from(`${JSON.stringify(marker)}\n`))) {
    throw new Error("legacy v2 apply complete marker is invalid or noncanonical");
  }
}

function manifestBytes(manifest) { return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); }
function completionBytes(operationId) {
  return Buffer.from(`${JSON.stringify({ schema: COMPLETE_SCHEMA, operationId })}\n`);
}
function rollbackIntentBytes(operationId) {
  return Buffer.from(`${JSON.stringify({ schema: ROLLBACK_INTENT_SCHEMA, operationId })}\n`);
}
function rollbackCompletionBytes(operationId) {
  return Buffer.from(`${JSON.stringify({ schema: ROLLBACK_COMPLETE_SCHEMA, operationId })}\n`);
}
function lockOwnerBytes(owner) { return Buffer.from(`${JSON.stringify(owner)}\n`); }

function ensureSafeDirectory(directory, allowedRoot) {
  assertDirectDescendant(directory, allowedRoot, true);
  const relative = path.relative(allowedRoot, directory);
  let current = allowedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    assertOneDirectory(current);
  }
}

function assertSafeDirectory(directory, allowedRoot, includeRoot = false) {
  assertDirectDescendant(directory, allowedRoot, includeRoot);
  const relative = path.relative(allowedRoot, directory);
  let current = allowedRoot;
  assertOneDirectory(current);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assertOneDirectory(current);
  }
}

function assertSafeRegularFile(filePath, allowedRoot) {
  assertDirectDescendant(filePath, allowedRoot, true);
  assertSafeDirectory(path.dirname(filePath), allowedRoot, true);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`path is not a non-reparse regular file: ${filePath}`);
}

function assertOneDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`path is not a non-reparse directory: ${directory}`);
}

function assertDirectChild(child, parent) {
  if (path.dirname(path.resolve(child)) !== path.resolve(parent)) throw new Error("operation path is outside backup allowlist");
}

function assertDirectDescendant(child, parent, allowEqual = false) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if ((relative === "" && !allowEqual) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path is outside allowlist: ${child}`);
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try { descriptor = fs.openSync(directory, "r"); fs.fsyncSync(descriptor); } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EBADF"].includes(error?.code)) throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function sameMappingList(mappings) {
  return Array.isArray(mappings) && mappings.length === MAPPINGS.length
    && mappings.every((mapping, index) => mapping?.relativePath === MAPPINGS[index]
      && typeof mapping.beforeSha256 === "string" && /^[a-f0-9]{64}$/.test(mapping.beforeSha256)
      && typeof mapping.afterSha256 === "string" && /^[a-f0-9]{64}$/.test(mapping.afterSha256)
      && mapping.backupRelativePath === path.posix.join("preimages", MAPPINGS[index]));
}

function hasExactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function parseArgs(argv) {
  const modeArg = argv.shift();
  if (modeArg !== "--check" && modeArg !== "--apply" && modeArg !== "--rollback") {
    throw new Error("usage: sync-source-command-skills.mjs <--check|--apply|--rollback <operation-id>> [--target-root <test-temp-dir>]");
  }
  let operationId;
  if (modeArg === "--rollback") operationId = argv.shift();
  if (modeArg === "--rollback" && !operationId) throw new Error("--rollback requires an operation id");
  let targetRoot;
  let hasTargetOverride = false;
  while (argv.length > 0) {
    const arg = argv.shift();
    if (arg !== "--target-root" || targetRoot !== undefined) throw new Error(`unknown or repeated option: ${arg}`);
    targetRoot = argv.shift();
    if (!targetRoot) throw new Error("--target-root requires a directory");
    hasTargetOverride = true;
  }
  return { mode: modeArg.slice(2), operationId, targetRoot, hasTargetOverride };
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function pathKey(value) { return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value); }
function message(error) { return error instanceof Error ? error.message : String(error); }
