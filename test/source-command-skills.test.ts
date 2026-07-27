import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "sync-source-command-skills.mjs");
const assetRoot = path.join(repoRoot, "assets", "source-command-skills");
const backupDirectory = ".threadpass-source-command-skill-backups";
const lockDirectory = ".threadpass-source-command-skill-sync.lock";
const mappings = [
  "source-command-save-session/SKILL.md",
  "source-command-resume-session/SKILL.md",
] as const;

function run(args: string[], env: Record<string, string> = {}, guarded = true) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(guarded ? { THREADPASS_SKILL_SYNC_TEST_ROOT: "1" } : {}),
      ...env,
    },
  });
}

function runAsync(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, THREADPASS_SKILL_SYNC_TEST_ROOT: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function tempTarget(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "threadpass-skill-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of mappings) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `old:${relative}\r\n`);
  }
  return root;
}

function parse(result: ReturnType<typeof run>): Record<string, unknown> {
  return JSON.parse(result.stdout || result.stderr) as Record<string, unknown>;
}

function operationIds(root: string): string[] {
  const backupRoot = path.join(root, backupDirectory);
  return fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
}

function assertAssetsInstalled(root: string): void {
  for (const relative of mappings) {
    assert.deepEqual(fs.readFileSync(path.join(root, relative)), fs.readFileSync(path.join(assetRoot, relative)), relative);
  }
}

function publicationPaths(root: string, operationId: string, relative: string, direction: "apply" | "rollback") {
  const target = path.join(root, relative);
  const suffix = `.threadpass-${operationId}.${direction}`;
  return {
    target,
    stage: `${target}${suffix}.stage`,
    publication: `${target}${suffix}.publication`,
    moved: `${target}${suffix}.moved`,
  };
}

function releaseQuarantines(root: string): string[] {
  return fs.readdirSync(root)
    .filter((entry) => entry.startsWith(`${lockDirectory}.release-`))
    .map((entry) => path.join(root, entry));
}

test("versioned skills use the installed artifact command and treat handoff bodies as untrusted", () => {
  const save = fs.readFileSync(path.join(assetRoot, mappings[0]), "utf8");
  const resume = fs.readFileSync(path.join(assetRoot, mappings[1]), "utf8");
  assert.match(save, /threadpass handoff header/);
  assert.match(resume, /threadpass handoff read/);
  assert.doesNotMatch(resume, /threadpass handoff resolve/);
  for (const text of [save, resume]) {
    assert.match(text, /npm pack/);
    assert.match(text, /npm install --global <exact-tarball-path>/);
    assert.doesNotMatch(text, /npm install --global pass-the-thread/);
    assert.doesNotMatch(text, /full context|exactly where (?:this one )?left off/i);
  }
  assert.match(resume, /Never reopen `resolvedPath`/);
  assert.match(resume, /untrusted historical data/);
  assert.match(resume, /Vague replies[\s\S]*do not authorize/);
  assert.match(resume, /not a native Codex resume, Goal, compaction/);
});

test("save-session mandates value-free redaction scans and owner-only storage", () => {
  const save = fs.readFileSync(path.join(assetRoot, mappings[0]), "utf8");
  assert.match(save, /authorization headers/i);
  assert.match(save, /logs? (?:and|or|\/|,) error payloads/i);
  assert.match(save, /command output/i);
  assert.match(save, /shell history|command history/i);
  assert.match(save, /config(?:uration)? (?:and|or|\/|,) credential stores/i);
  assert.match(save, /API keys?.*access tokens?.*refresh tokens?.*passwords?.*cookies?.*private keys?.*seed phrases?/is);
  assert.match(save, /names? and (?:typed )?(?:redaction )?placeholders? only/i);
  assert.match(save, /scan[^\n]*before[^\n]*writ/is);
  assert.match(save, /scan[^\n]*before[^\n]*display/is);
  assert.match(save, /0700[^\n]*0600|0600[^\n]*0700/i);
  assert.match(save, /Windows[^\n]*owner-only ACL/i);
  assert.match(save, /fail closed[^\n]*(?:permission|ACL)|(?:permission|ACL)[^\n]*fail closed/i);
  assert.match(save, /precise remediation/i);
});

test("check reports equality and mismatch without mutation", (t) => {
  const root = tempTarget(t);
  for (const relative of mappings) fs.copyFileSync(path.join(assetRoot, relative), path.join(root, relative));
  const equal = run(["--check", "--target-root", root]);
  assert.equal(equal.status, 0, equal.stderr);
  assert.equal(parse(equal).status, "equal");
  const changed = path.join(root, mappings[0]);
  fs.appendFileSync(changed, "edit");
  const before = fs.readFileSync(changed);
  const mismatch = run(["--check", "--target-root", root]);
  assert.equal(mismatch.status, 1);
  assert.equal(parse(mismatch).status, "mismatch");
  assert.deepEqual(fs.readFileSync(changed), before);
});

test("apply prepares every durable preimage before any target move", (t) => {
  const root = tempTarget(t);
  const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
  const interrupted = run(
    ["--apply", "--target-root", root],
    { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "after-prepared" },
  );
  assert.equal(interrupted.status, 1);
  assert.match(interrupted.stderr, /after-prepared/);
  mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), originals[index]));
  const [operationId] = operationIds(root);
  assert.ok(operationId);
  const operationRoot = path.join(root, backupDirectory, operationId);
  const manifest = JSON.parse(fs.readFileSync(path.join(operationRoot, "manifest.json"), "utf8")) as {
    mappings: Array<{ relativePath: string; backupRelativePath: string }>;
  };
  for (const [index, mapping] of manifest.mappings.entries()) {
    assert.deepEqual(fs.readFileSync(path.join(operationRoot, mapping.backupRelativePath)), originals[index]);
  }
});

test("partial manifest and stage temps recover only before publication", (t) => {
  for (const point of ["manifest-after-partial", "stage-1-after-partial"]) {
    const root = tempTarget(t);
    const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
    const interrupted = run(
      ["--apply", "--target-root", root],
      { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: point },
    );
    assert.equal(interrupted.status, 1, `${point}: ${interrupted.stdout}`);
    assert.match(interrupted.stderr, new RegExp(point));
    mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), originals[index]));
    const recovered = run(["--apply", "--target-root", root]);
    assert.equal(recovered.status, 0, `${point}: ${recovered.stderr}`);
    assertAssetsInstalled(root);
  }
});

test("partial completion marker preserves published targets and fails with recoverable evidence", (t) => {
  const root = tempTarget(t);
  const interrupted = run(
    ["--apply", "--target-root", root],
    { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "complete-after-partial" },
  );
  assert.equal(interrupted.status, 1);
  assert.match(interrupted.stderr, /complete-after-partial/);
  assertAssetsInstalled(root);
  const retry = run(["--apply", "--target-root", root]);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /partial artifact[\s\S]*recover/i);
  assertAssetsInstalled(root);
});

test("a malformed final completion marker is never treated as complete", (t) => {
  const root = tempTarget(t);
  const applied = run(["--apply", "--target-root", root]);
  assert.equal(applied.status, 0, applied.stderr);
  const operationId = parse(applied).operationId as string;
  fs.writeFileSync(path.join(root, backupDirectory, operationId, "complete.json"), "{partial");
  const retry = run(["--apply", "--target-root", root]);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /complete marker|existing journal file|invalid/i);
});

for (const point of [
  "after-move-1",
  "after-link-1",
  "after-publish-1",
  "after-move-2",
  "after-link-2",
  "after-publish-2",
  "after-all-published",
]) {
  test(`apply recovers the exact pending operation after ${point}`, (t) => {
    const root = tempTarget(t);
    const interrupted = run(
      ["--apply", "--target-root", root],
      { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: point },
    );
    assert.equal(interrupted.status, 1, interrupted.stdout);
    assert.match(interrupted.stderr, new RegExp(point));
    const [operationId] = operationIds(root);
    assert.ok(operationId);
    const recovered = run(["--apply", "--target-root", root]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(parse(recovered).status, "recovered");
    assert.equal(parse(recovered).operationId, operationId);
    assert.ok(fs.existsSync(path.join(root, backupDirectory, operationId, "complete.json")));
    assertAssetsInstalled(root);
    assert.deepEqual(operationIds(root), [operationId]);
  });
}

test("partial rollback completion marker preserves restored targets and fails with evidence", (t) => {
  const root = tempTarget(t);
  const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
  const applied = run(["--apply", "--target-root", root]);
  assert.equal(applied.status, 0, applied.stderr);
  const operationId = parse(applied).operationId as string;
  const interrupted = run(
    ["--rollback", operationId, "--target-root", root],
    { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "rollback-complete-after-partial" },
  );
  assert.equal(interrupted.status, 1);
  assert.match(interrupted.stderr, /rollback-complete-after-partial/);
  mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), originals[index]));
  const retry = run(["--rollback", operationId, "--target-root", root]);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /partial artifact[\s\S]*recover/i);
});

test("apply is idempotent and rollback restores exact bytes", (t) => {
  const root = tempTarget(t);
  const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
  const applied = run(["--apply", "--target-root", root]);
  assert.equal(applied.status, 0, applied.stderr);
  const operationId = parse(applied).operationId as string;
  const second = run(["--apply", "--target-root", root]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(parse(second).status, "up-to-date");
  assert.equal(parse(second).operationId, null);
  const rolledBack = run(["--rollback", operationId, "--target-root", root]);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), originals[index]));
  const secondRollback = run(["--rollback", operationId, "--target-root", root]);
  assert.equal(secondRollback.status, 0, secondRollback.stderr);
  assert.equal(parse(secondRollback).status, "already-rolled-back");
  assert.deepEqual(releaseQuarantines(root), [], "a lock released to its own owner leaves no release directory");
  assert.equal(fs.existsSync(path.join(root, lockDirectory)), false);
});

test("a verified apply discards its journal artifacts and keeps the durable preimage", (t) => {
  const root = tempTarget(t);
  const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
  const applied = run(["--apply", "--target-root", root]);
  assert.equal(applied.status, 0, applied.stderr);
  const operationId = parse(applied).operationId as string;
  const operationRoot = path.join(root, backupDirectory, operationId);
  mappings.forEach((relative, index) => {
    const paths = publicationPaths(root, operationId, relative, "apply");
    for (const artifact of [paths.stage, paths.publication, paths.moved]) {
      assert.equal(fs.existsSync(artifact), false, artifact);
    }
    assert.deepEqual(fs.readFileSync(path.join(operationRoot, "preimages", relative)), originals[index]);
  });
  assertAssetsInstalled(root);
  assert.deepEqual(
    fs.readdirSync(path.join(root, path.dirname(mappings[0]))).sort(),
    [path.basename(mappings[0])],
  );

  const rolledBack = run(["--rollback", operationId, "--target-root", root]);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  mappings.forEach((relative, index) => {
    assert.deepEqual(fs.readFileSync(path.join(root, relative)), originals[index]);
    const paths = publicationPaths(root, operationId, relative, "rollback");
    assert.deepEqual(fs.readFileSync(paths.stage), originals[index]);
    assert.deepEqual(fs.readFileSync(paths.moved), fs.readFileSync(path.join(assetRoot, relative)));
  });
});

for (const direction of ["apply", "rollback"] as const) {
  for (const fault of ["missing-publication", "independent-publication", "stage-target-alias"] as const) {
    test(`${direction} recovery refuses ${fault} evidence before mutation or completion`, (t) => {
      const root = tempTarget(t);
      const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
      let operationId: string;
      if (direction === "apply") {
        const interrupted = run(
          ["--apply", "--target-root", root],
          { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "after-link-1" },
        );
        assert.equal(interrupted.status, 1, interrupted.stdout);
        assert.match(interrupted.stderr, /after-link-1/);
        [operationId] = operationIds(root);
      } else {
        const applied = run(["--apply", "--target-root", root]);
        assert.equal(applied.status, 0, applied.stderr);
        operationId = parse(applied).operationId as string;
        const interrupted = run(
          ["--rollback", operationId, "--target-root", root],
          { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "rollback-after-link-1" },
        );
        assert.equal(interrupted.status, 1, interrupted.stdout);
        assert.match(interrupted.stderr, /rollback-after-link-1/);
      }

      const paths = publicationPaths(root, operationId, mappings[0], direction);
      const evidencePath = fault === "stage-target-alias"
        ? `${paths.stage}.original-evidence`
        : `${paths.publication}.original-evidence`;
      if (fault === "stage-target-alias") {
        fs.renameSync(paths.stage, evidencePath);
        fs.linkSync(paths.target, paths.stage);
      } else {
        fs.renameSync(paths.publication, evidencePath);
        if (fault === "independent-publication") fs.copyFileSync(paths.target, paths.publication, fs.constants.COPYFILE_EXCL);
      }

      const beforeRetry = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
      const retry = direction === "apply"
        ? run(["--apply", "--target-root", root])
        : run(["--rollback", operationId, "--target-root", root]);
      assert.equal(retry.status, 1, retry.stdout);
      assert.match(retry.stderr, /publication evidence|inode|alias|manual review/i);
      mappings.forEach((relative, index) => {
        assert.deepEqual(fs.readFileSync(path.join(root, relative)), beforeRetry[index], relative);
      });
      assert.ok(fs.existsSync(evidencePath), "original evidence remains preserved");
      const completion = direction === "apply" ? "complete.json" : "rollback-complete.json";
      assert.equal(fs.existsSync(path.join(root, backupDirectory, operationId, completion)), false);
      if (direction === "rollback") {
        assert.deepEqual(beforeRetry[0], originals[0], "first rollback target was published before interruption");
        assert.notDeepEqual(beforeRetry[1], originals[1], "second rollback target remains unapplied");
      }
    });
  }
}

test("a temp-cloned completed v2 manifest and preimages remain rollback-compatible", (t) => {
  const root = tempTarget(t);
  const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
  const applied = run(["--apply", "--target-root", root]);
  assert.equal(applied.status, 0, applied.stderr);
  const operationId = parse(applied).operationId as string;
  const operationRoot = path.join(root, backupDirectory, operationId);
  const manifestPath = path.join(operationRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.schema = "threadpass.source-command-skill-sync/v2";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(operationRoot, "complete.json"),
    `${JSON.stringify({ completedAt: "2026-07-27T00:00:00.000Z" })}\n`,
  );
  const rolledBack = run(["--rollback", operationId, "--target-root", root]);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), originals[index]));
});

for (const point of [
  "rollback-after-move-1",
  "rollback-after-link-1",
  "rollback-after-publish-1",
  "rollback-after-move-2",
  "rollback-after-link-2",
  "rollback-after-publish-2",
  "rollback-after-all-published",
]) {
  test(`rollback recovers safely after ${point}`, (t) => {
    const root = tempTarget(t);
    const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
    const applied = run(["--apply", "--target-root", root]);
    assert.equal(applied.status, 0, applied.stderr);
    const operationId = parse(applied).operationId as string;
    const interrupted = run(
      ["--rollback", operationId, "--target-root", root],
      { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: point },
    );
    assert.equal(interrupted.status, 1);
    assert.match(interrupted.stderr, new RegExp(point));
    const recovered = run(["--rollback", operationId, "--target-root", root]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(parse(recovered).status, "recovered");
    mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), originals[index]));
    assert.ok(fs.existsSync(path.join(root, backupDirectory, operationId, "rollback-complete.json")));
  });
}

test("rollback CAS-refuses a live edit before mutation", (t) => {
  const root = tempTarget(t);
  const applied = run(["--apply", "--target-root", root]);
  assert.equal(applied.status, 0, applied.stderr);
  const operationId = parse(applied).operationId as string;
  const edited = path.join(root, mappings[0]);
  fs.appendFileSync(edited, "user edit");
  const before = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
  const rollbackResult = run(["--rollback", operationId, "--target-root", root]);
  assert.equal(rollbackResult.status, 1);
  assert.match(rollbackResult.stderr, /live target was edited/);
  mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), before[index]));
});

test("canonical active and stale locks always fail closed without mutation", (t) => {
  for (const owner of [
    { pid: process.pid, nonce: "active", mode: "apply", createdAt: new Date().toISOString() },
    { pid: 2_147_483_647, nonce: "stale", mode: "apply", createdAt: "2000-01-01T00:00:00.000Z" },
  ]) {
    const root = tempTarget(t);
    const canonical = path.join(root, lockDirectory);
    fs.mkdirSync(canonical);
    const ownerBytes = Buffer.from(`${JSON.stringify({ schema: "threadpass.source-command-skill-lock/v2", ...owner })}\n`);
    fs.writeFileSync(path.join(canonical, "owner.json"), ownerBytes);
    if (owner.nonce === "stale") {
      const old = new Date("2000-01-01T00:00:00.000Z");
      fs.utimesSync(canonical, old, old);
    }
    const beforeEntries = fs.readdirSync(root).sort();
    const result = run(["--apply", "--target-root", root]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /lock[\s\S]*manual|manual[\s\S]*lock/i);
    assert.match(result.stderr, new RegExp(String(owner.pid)));
    assert.deepEqual(fs.readFileSync(path.join(canonical, "owner.json")), ownerBytes);
    assert.deepEqual(fs.readdirSync(root).sort(), beforeEntries);
  }
});

for (const point of ["lock-pre-owner", "lock-post-owner"]) {
  test(`direct canonical lock interruption at ${point} remains fail-closed`, (t) => {
    const root = tempTarget(t);
    const before = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
    const interrupted = run(
      ["--apply", "--target-root", root],
      { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: point },
    );
    assert.equal(interrupted.status, 1);
    assert.match(interrupted.stderr, new RegExp(point));
    const canonical = path.join(root, lockDirectory);
    assert.ok(fs.existsSync(canonical));
    assert.equal(fs.existsSync(path.join(canonical, "owner.json")), point === "lock-post-owner");
    const retry = run(["--apply", "--target-root", root]);
    assert.equal(retry.status, 1, retry.stdout);
    assert.match(retry.stderr, /manual|coordinate/i);
    mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), before[index]));
  });
}

test("simultaneous direct canonical lock contenders have exactly one owner", async (t) => {
  const root = tempTarget(t);
  const before = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
  const contenders = await Promise.all(Array.from({ length: 6 }, () => runAsync(
    ["--apply", "--target-root", root],
    { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "lock-post-owner" },
  )));
  assert.ok(contenders.every((result) => result.status === 1));
  assert.equal(contenders.filter((result) => /injected interruption at lock-post-owner/.test(result.stderr)).length, 1);
  assert.equal(contenders.filter((result) => /manual|coordinate/i.test(result.stderr)).length, 5);
  const canonical = path.join(root, lockDirectory);
  assert.ok(fs.existsSync(path.join(canonical, "owner.json")));
  assert.equal(fs.readdirSync(canonical).filter((entry) => entry === "owner.json").length, 1);
  mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), before[index]));
});

test("an abandoned canonical lock stays fail-closed even after it becomes old", (t) => {
  const root = tempTarget(t);
  const interrupted = run(
    ["--apply", "--target-root", root],
    { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "lock-post-publish" },
  );
  assert.equal(interrupted.status, 1);
  assert.match(interrupted.stderr, /lock-post-publish/);
  const canonical = path.join(root, lockDirectory);
  assert.ok(fs.existsSync(canonical));
  const fresh = run(["--apply", "--target-root", root]);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /busy|lock/i);
  const ownerPath = path.join(canonical, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
  owner.createdAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
  const old = new Date("2000-01-01T00:00:00.000Z");
  fs.utimesSync(canonical, old, old);
  const ownerBytes = fs.readFileSync(ownerPath);
  const beforeEntries = fs.readdirSync(root).sort();
  const refused = run(["--apply", "--target-root", root]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /manual|coordinate/i);
  assert.deepEqual(fs.readFileSync(ownerPath), ownerBytes);
  assert.deepEqual(fs.readdirSync(root).sort(), beforeEntries);
});

test("missing or malformed fresh canonical lock owners are busy", (t) => {
  for (const contents of [null, "{partial"]) {
    const root = tempTarget(t);
    const canonical = path.join(root, lockDirectory);
    fs.mkdirSync(canonical);
    if (contents !== null) fs.writeFileSync(path.join(canonical, "owner.json"), contents);
    const beforeEntries = fs.readdirSync(root).sort();
    const beforeOwner = contents === null ? null : fs.readFileSync(path.join(canonical, "owner.json"));
    const result = run(["--apply", "--target-root", root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lock[\s\S]*manual|manual[\s\S]*lock/i);
    assert.ok(fs.existsSync(canonical));
    assert.deepEqual(fs.readdirSync(root).sort(), beforeEntries);
    if (beforeOwner !== null) assert.deepEqual(fs.readFileSync(path.join(canonical, "owner.json")), beforeOwner);
  }
});

for (const mode of ["apply", "rollback"] as const) {
  for (const boundary of ["before-rename", "after-rename"] as const) {
    test(`${mode} lock release preserves replacement owner bytes ${boundary}`, (t) => {
      const root = tempTarget(t);
      let operationId: string | null = null;
      if (mode === "rollback") {
        const applied = run(["--apply", "--target-root", root]);
        assert.equal(applied.status, 0, applied.stderr);
        operationId = parse(applied).operationId as string;
      }
      const args = mode === "apply"
        ? ["--apply", "--target-root", root]
        : ["--rollback", operationId as string, "--target-root", root];
      const result = run(args, {
        THREADPASS_SKILL_SYNC_TEST_RELEASE_FAULT_AT: `lock-release-${boundary}`,
        THREADPASS_SKILL_SYNC_TEST_RELEASE_FAULT_KIND: "replace-lock-external",
      });
      if (boundary === "before-rename") assert.equal(result.status, 1, result.stdout);
      else assert.equal(result.status, 0, result.stderr);
      if (mode === "apply") assertAssetsInstalled(root);
      else mappings.forEach((relative) => assert.match(fs.readFileSync(path.join(root, relative), "utf8"), /^old:/));
      const canonicalOwner = path.join(root, lockDirectory, "owner.json");
      assert.ok(fs.existsSync(canonicalOwner));
      assert.match(fs.readFileSync(canonicalOwner, "utf8"), new RegExp(`external-${boundary}`));
      const quarantines = releaseQuarantines(root);
      if (boundary === "before-rename") {
        assert.ok(quarantines.length >= 1, "a foreign release claim remains as operation evidence");
        assert.ok(quarantines.some((directory) => fs.existsSync(path.join(directory, "owner.json"))));
      } else {
        assert.deepEqual(quarantines, [], "a release verified as ours is discarded instead of left behind");
      }
    });
  }
}

test("apply exclusive publish never overwrites an external target", (t) => {
  const root = tempTarget(t);
  const interrupted = run(
    ["--apply", "--target-root", root],
    { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "before-publish-1" },
  );
  assert.equal(interrupted.status, 1);
  const target = path.join(root, mappings[0]);
  const external = Buffer.from("external apply bytes\n");
  fs.writeFileSync(target, external, { flag: "wx" });
  const retry = run(["--apply", "--target-root", root]);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /external|publication|journal state/i);
  assert.deepEqual(fs.readFileSync(target), external);
});

test("rollback exclusive publish never overwrites an external target", (t) => {
  const root = tempTarget(t);
  const applied = run(["--apply", "--target-root", root]);
  assert.equal(applied.status, 0, applied.stderr);
  const operationId = parse(applied).operationId as string;
  const interrupted = run(
    ["--rollback", operationId, "--target-root", root],
    { THREADPASS_SKILL_SYNC_TEST_INTERRUPT_AT: "rollback-before-publish-1" },
  );
  assert.equal(interrupted.status, 1);
  const target = path.join(root, mappings[0]);
  const external = Buffer.from("external rollback bytes\n");
  fs.writeFileSync(target, external, { flag: "wx" });
  const retry = run(["--rollback", operationId, "--target-root", root]);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /external|publication|journal state|edited/i);
  assert.deepEqual(fs.readFileSync(target), external);
});

for (const direction of ["apply", "rollback"] as const) {
  for (const timing of ["before-link", "after-link"] as const) {
    for (const fault of ["mutate-stage", "swap-stage"] as const) {
      test(`${direction} binds a validated stage across ${fault} ${timing}`, (t) => {
        const root = tempTarget(t);
        const originals = mappings.map((relative) => fs.readFileSync(path.join(root, relative)));
        let operationId: string | null = null;
        if (direction === "rollback") {
          const applied = run(["--apply", "--target-root", root]);
          assert.equal(applied.status, 0, applied.stderr);
          operationId = parse(applied).operationId as string;
        }
        const args = direction === "apply"
          ? ["--apply", "--target-root", root]
          : ["--rollback", operationId as string, "--target-root", root];
        const result = run(args, {
          THREADPASS_SKILL_SYNC_TEST_FAULT_AT: `${direction}-${timing}-1`,
          THREADPASS_SKILL_SYNC_TEST_FAULT_KIND: fault,
        });
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, /stage|publish|inode|snapshot|hash/i);
        operationId ??= operationIds(root)[0] ?? null;
        assert.ok(operationId);
        const paths = publicationPaths(root, operationId, mappings[0], direction);
        assert.ok(fs.existsSync(paths.stage), "the failed stage remains as recoverable evidence");
        if (direction === "apply") {
          mappings.forEach((relative, index) => assert.deepEqual(fs.readFileSync(path.join(root, relative)), originals[index]));
        } else {
          assertAssetsInstalled(root);
        }
        assert.ok(fs.existsSync(paths.moved), "verified moved preimage remains after no-replace restoration");
      });
    }
  }
}

for (const direction of ["apply", "rollback"] as const) {
  test(`${direction} cleanup preserves an external target replacement after link`, (t) => {
    const root = tempTarget(t);
    let operationId: string | null = null;
    if (direction === "rollback") {
      const applied = run(["--apply", "--target-root", root]);
      assert.equal(applied.status, 0, applied.stderr);
      operationId = parse(applied).operationId as string;
    }
    const args = direction === "apply"
      ? ["--apply", "--target-root", root]
      : ["--rollback", operationId as string, "--target-root", root];
    const result = run(args, {
      THREADPASS_SKILL_SYNC_TEST_FAULT_AT: `${direction}-after-link-1`,
      THREADPASS_SKILL_SYNC_TEST_FAULT_KIND: "replace-target-external",
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /external|publish|inode|snapshot|hash/i);
    operationId ??= operationIds(root)[0] ?? null;
    assert.ok(operationId);
    const paths = publicationPaths(root, operationId, mappings[0], direction);
    assert.deepEqual(fs.readFileSync(paths.target), Buffer.from(`external ${direction} replacement\n`));
    assert.ok(fs.existsSync(paths.moved), "moved evidence remains when the external target blocks restoration");
  });
}

for (const direction of ["apply", "rollback"] as const) {
  for (const boundary of ["before-claim", "after-claim"] as const) {
    test(`${direction} cleanup atomically claims its link and retains external bytes ${boundary}`, (t) => {
      const root = tempTarget(t);
      let operationId: string | null = null;
      if (direction === "rollback") {
        const applied = run(["--apply", "--target-root", root]);
        assert.equal(applied.status, 0, applied.stderr);
        operationId = parse(applied).operationId as string;
      }
      const args = direction === "apply"
        ? ["--apply", "--target-root", root]
        : ["--rollback", operationId as string, "--target-root", root];
      const result = run(args, {
        THREADPASS_SKILL_SYNC_TEST_FAULT_AT: `${direction}-after-link-1`,
        THREADPASS_SKILL_SYNC_TEST_FAULT_KIND: "mutate-stage",
        THREADPASS_SKILL_SYNC_TEST_CLEANUP_FAULT_AT: `${direction}-cleanup-${boundary}-1`,
        THREADPASS_SKILL_SYNC_TEST_CLEANUP_FAULT_KIND: "replace-target-external",
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /claim|external|quarantine|cleanup|publish/i);
      operationId ??= operationIds(root)[0] ?? null;
      assert.ok(operationId);
      const paths = publicationPaths(root, operationId, mappings[0], direction);
      assert.deepEqual(fs.readFileSync(paths.target), Buffer.from(`external ${direction} cleanup ${boundary}\n`));
      assert.ok(fs.existsSync(paths.moved), "moved preimage remains while external bytes own the target");
    });
  }
}

test("sync exposes no unguarded arbitrary target and rejects unsafe paths", (t) => {
  const unguarded = tempTarget(t);
  const denied = run(["--check", "--target-root", unguarded], {}, false);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /available only/);

  const missing = tempTarget(t);
  fs.unlinkSync(path.join(missing, mappings[0]));
  assert.equal(run(["--check", "--target-root", missing]).status, 1);
  assert.equal(run(["--rollback", "../escape", "--target-root", tempTarget(t)]).status, 1);

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "threadpass-skill-link-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const real = tempTarget(t);
  const linked = path.join(fixture, "linked");
  try {
    fs.symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return;
  }
  const result = run(["--check", "--target-root", linked]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reparse|directory/i);
});

test("production cleanup never unlinks preimage, quarantine, or lock evidence", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.doesNotMatch(source, /unlinkSync\(movedPath\)|unlinkSync\(claimedPath\)/);
  assert.doesNotMatch(source, /unlinkSync\(path\.join\(lockRoot, "owner\.json"\)\)|rmdirSync\(lockRoot\)/);
  assert.doesNotMatch(source, /(?:unlink|rm)Sync\([^)]*(?:backup|preimage|quarantine|claim)/i);
  const discard = source.slice(source.indexOf("function discardApplyJournalArtifacts"), source.indexOf("function convergeRollback"));
  assert.match(discard, /paths\.stage, paths\.publication, paths\.moved/);
  assert.doesNotMatch(discard, /backupRelativePath|operationFile|operation\.root/);
});

test("lock acquisition uses one direct canonical mkdir without private publication", () => {
  const source = fs.readFileSync(script, "utf8");
  const acquisition = source.slice(source.indexOf("function withTargetLock"), source.indexOf("function releaseLock"));
  assert.match(acquisition, /mkdirSync\(lockRoot/);
  assert.doesNotMatch(acquisition, /existsSync\(lockRoot\)|privateRoot|renameSync\([^,]+, lockRoot\)/);
});
