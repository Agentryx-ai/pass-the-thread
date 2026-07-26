import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  CODEX_GOAL_CLEAR_ROLLBACK_SUPPORTED,
  CODEX_GOAL_TARGET_CAPABILITY_ID,
  CODEX_GOAL_TARGET_FINGERPRINT,
  assertCodexGoalReadback,
  createCodexGoalRpc,
  codexGoalTargetTesting,
  parseCodexGoalGetResult,
  planCodexGoalActivation,
  type CodexGoalExpectedReadback,
  type CodexGoalRpc,
  type CodexThreadGoal,
} from "../src/codex-goal-target.ts";
import {
  acquireCodexTargetLock,
  applyCodexTarget,
  planCodexTarget,
  releaseCodexTargetLock,
} from "../src/codex-target.ts";
import { registerCodexThread41059, threadRolloutPath } from "../src/codex-target-db.ts";
import { createCanonicalGoalSnapshot } from "../src/goal.ts";
import {
  loadOperationJournal,
  reconcileGoalActivation,
  recoverCreatedFiles,
} from "../src/operation-journal.ts";
import {
  SUPPORTED_CODEX_TARGET,
  loadInstalledCodexTargetEvidence,
} from "../src/version-gate.ts";

const EVIDENCE = { ...SUPPORTED_CODEX_TARGET };

function canonicalGoal(status: "active" | "complete" = "active", provider = "claude") {
  return createCanonicalGoalSnapshot({
    authority: "native-transcript", provider, sourceThreadId: "source", sourceGoalId: null,
    objective: "ship safely", status, tokenBudget: 1234, tokensUsed: 99, timeUsedSeconds: 88,
    createdAtMs: 1, updatedAtMs: 2,
    locator: { sourcePath: "C:/source.jsonl", recordIndex: 0, table: null, key: "source" },
    sourceMaterial: { status, provider },
  });
}

function createStateDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER, updated_at INTEGER,
      source TEXT, model_provider TEXT, cwd TEXT, title TEXT, sandbox_policy TEXT,
      approval_mode TEXT, tokens_used INTEGER, has_user_event INTEGER, archived INTEGER,
      archived_at INTEGER, cli_version TEXT, first_user_message TEXT, memory_mode TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER, preview TEXT, recency_at INTEGER,
      recency_at_ms INTEGER, history_mode TEXT
    )`);
  } finally { db.close(); }
}

function targetFixture(goal = canonicalGoal()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-target-"));
  const codexHome = path.join(root, "codex");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(codexHome);
  const dbPath = path.join(codexHome, "state_5.sqlite");
  createStateDb(dbPath);
  const plan = planCodexTarget(codexHome, dbPath, "source", "a".repeat(64), {
    cwd: root, title: "Goal target", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user", text: "hello" }],
  }, false, goal, "migrate");
  return { root, codexHome, bridgeRoot, dbPath, plan };
}

function nativeGoal(expected: CodexGoalExpectedReadback): CodexThreadGoal {
  return { ...expected, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 100, updatedAt: 100 };
}

class FakeGoalRpc implements CodexGoalRpc {
  current: CodexThreadGoal | null;
  gets = 0;
  sets = 0;
  probes = 0;
  disposed = false;
  failReadback = false;
  failAfterSetMutation = false;
  constructor(current: CodexThreadGoal | null = null) { this.current = current; }
  probe(): void { this.probes += 1; }
  get(): CodexThreadGoal | null {
    this.gets += 1;
    if (this.failReadback && this.sets > 0) throw new Error("simulated restart readback failure");
    return this.current;
  }
  set(request: CodexGoalExpectedReadback): CodexThreadGoal {
    this.sets += 1;
    this.current = nativeGoal(request);
    if (this.failAfterSetMutation) throw new Error("simulated crash after native set");
    return this.current;
  }
  dispose(): void { this.disposed = true; }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test process state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("Codex Goal planning binds exact target semantics and never maps provider counters", () => {
  const active = canonicalGoal();
  const plan = planCodexGoalActivation(active, "migrate", "target");
  assert.equal(plan?.capabilityId, CODEX_GOAL_TARGET_CAPABILITY_ID);
  assert.equal(plan?.profileFingerprint, CODEX_GOAL_TARGET_FINGERPRINT);
  assert.deepEqual(plan?.expectedReadback, {
    threadId: "target", objective: "ship safely", status: "active", tokenBudget: null,
  });
  assert.equal(plan?.sourceCountersMigrated, false);
  assert.equal(planCodexGoalActivation(active, "skip", "target"), null);
  assert.equal(planCodexGoalActivation(canonicalGoal("complete"), "migrate", "target"), null);
  assert.equal(planCodexGoalActivation(canonicalGoal("active", "codex"), "migrate", "target")?.request.tokenBudget, 1234);
  assert.equal(CODEX_GOAL_CLEAR_ROLLBACK_SUPPORTED, false);
});

test("Goal get accepts only an explicit null or a fully validated Goal envelope", () => {
  assert.equal(parseCodexGoalGetResult({ goal: null }), null);
  assert.deepEqual(
    parseCodexGoalGetResult({ goal: nativeGoal({ threadId: "t", objective: "o", status: "active", tokenBudget: null }) }),
    nativeGoal({ threadId: "t", objective: "o", status: "active", tokenBudget: null }),
  );
  for (const malformed of [{}, { goal: undefined }, null, [], { result: null }]) {
    assert.throws(() => parseCodexGoalGetResult(malformed), /invalid Codex Goal get response envelope|invalid Codex Goal RPC response/);
  }
});

test("apply activates by RPC, verifies restart readback, and leaves rollout bytes unchanged", () => {
  const fixture = targetFixture();
  const rpc = new FakeGoalRpc();
  const lock = acquireCodexTargetLock(fixture.codexHome);
  let journal;
  try {
    journal = applyCodexTarget(fixture.plan, {
      allowWrite: true, evidence: EVIDENCE, bridgeRoot: fixture.bridgeRoot, lock,
      goalRpc: rpc, desktopGuard: () => {},
    });
  } finally { releaseCodexTargetLock(lock); }
  assert.equal(journal.state, "committed");
  assert.equal(rpc.gets, 2);
  assert.equal(rpc.sets, 1);
  assertCodexGoalReadback(rpc.current, fixture.plan.goalActivation!.expectedReadback);
  assert.equal(createHash("sha256").update(fs.readFileSync(fixture.plan.rolloutPath)).digest("hex"), fixture.plan.rolloutSha256);
});

test("an existing Goal is a collision and is never overwritten", () => {
  const fixture = targetFixture();
  const expected = fixture.plan.goalActivation!.expectedReadback;
  const rpc = new FakeGoalRpc(nativeGoal({ ...expected, objective: "user replacement" }));
  const lock = acquireCodexTargetLock(fixture.codexHome);
  try {
    assert.throws(() => applyCodexTarget(fixture.plan, {
      allowWrite: true, evidence: EVIDENCE, bridgeRoot: fixture.bridgeRoot, lock,
      goalRpc: rpc, desktopGuard: () => {},
    }), /Goal collision/);
  } finally { releaseCodexTargetLock(lock); }
  assert.equal(rpc.sets, 0);
  assert.equal(fs.existsSync(fixture.plan.rolloutPath), true);
  assert.equal(threadRolloutPath(fixture.dbPath, fixture.plan.threadId), fixture.plan.rolloutPath);
  assert.equal(loadOperationJournal(fixture.bridgeRoot, fixture.plan.operationId).state, "reconciliation-required");
});

test("an exact existing Goal is idempotent and performs no set mutation", () => {
  const fixture = targetFixture();
  const rpc = new FakeGoalRpc(nativeGoal(fixture.plan.goalActivation!.expectedReadback));
  const lock = acquireCodexTargetLock(fixture.codexHome);
  try {
    const result = applyCodexTarget(fixture.plan, {
      allowWrite: true, evidence: EVIDENCE, bridgeRoot: fixture.bridgeRoot, lock,
      goalRpc: rpc, desktopGuard: () => {},
    });
    assert.equal(result.state, "committed");
  } finally { releaseCodexTargetLock(lock); }
  assert.equal(rpc.sets, 0);
  assert.equal(rpc.gets, 1);
});

test("skip mode writes no live Goal RPC while the target plan remains usable", () => {
  const fixture = targetFixture();
  fixture.plan.goalActivation = null;
  const rpc = new FakeGoalRpc();
  const lock = acquireCodexTargetLock(fixture.codexHome);
  try {
    assert.equal(applyCodexTarget(fixture.plan, {
      allowWrite: true, evidence: EVIDENCE, bridgeRoot: fixture.bridgeRoot, lock,
      goalRpc: rpc, desktopGuard: () => {},
    }).state, "committed");
  } finally { releaseCodexTargetLock(lock); }
  assert.equal(rpc.gets, 0);
  assert.equal(rpc.sets, 0);
});

test("crash after native set but before journal confirmation rolls forward by exact readback", () => {
  const fixture = targetFixture();
  const rpc = new FakeGoalRpc();
  rpc.failAfterSetMutation = true;
  const lock = acquireCodexTargetLock(fixture.codexHome);
  try {
    assert.throws(() => applyCodexTarget(fixture.plan, {
      allowWrite: true, evidence: EVIDENCE, bridgeRoot: fixture.bridgeRoot, lock,
      goalRpc: rpc, desktopGuard: () => {},
    }), /requires reconciliation/);
  } finally { releaseCodexTargetLock(lock); }
  assert.equal(loadOperationJournal(fixture.bridgeRoot, fixture.plan.operationId).state, "reconciliation-required");
  assert.equal(reconcileGoalActivation(fixture.bridgeRoot, fixture.plan.operationId, rpc.current).state, "committed");
  assert.equal(rpc.sets, 1);
});

test("a crash-window Goal outcome preserves artifacts until exact reconciliation", () => {
  const fixture = targetFixture();
  const rpc = new FakeGoalRpc();
  rpc.failReadback = true;
  const lock = acquireCodexTargetLock(fixture.codexHome);
  try {
    assert.throws(() => applyCodexTarget(fixture.plan, {
      allowWrite: true, evidence: EVIDENCE, bridgeRoot: fixture.bridgeRoot, lock,
      goalRpc: rpc, desktopGuard: () => {},
    }), /requires reconciliation/);
  } finally { releaseCodexTargetLock(lock); }
  const pending = loadOperationJournal(fixture.bridgeRoot, fixture.plan.operationId);
  assert.equal(pending.state, "reconciliation-required");
  assert.ok(fs.existsSync(fixture.plan.rolloutPath));
  assert.ok(threadRolloutPath(fixture.dbPath, fixture.plan.threadId));
  assert.throws(() => recoverCreatedFiles(fixture.bridgeRoot, fixture.plan.operationId), /reconcile exact native readback/);
  assert.equal(reconcileGoalActivation(fixture.bridgeRoot, fixture.plan.operationId, rpc.current).state, "committed");
});

test("reconciliation refuses a differing Goal without calling unconditional clear", () => {
  const fixture = targetFixture();
  const rpc = new FakeGoalRpc();
  rpc.failReadback = true;
  const lock = acquireCodexTargetLock(fixture.codexHome);
  try {
    assert.throws(() => applyCodexTarget(fixture.plan, {
      allowWrite: true, evidence: EVIDENCE, bridgeRoot: fixture.bridgeRoot, lock,
      goalRpc: rpc, desktopGuard: () => {},
    }));
  } finally { releaseCodexTargetLock(lock); }
  const differing = nativeGoal({ ...fixture.plan.goalActivation!.expectedReadback, objective: "user changed it" });
  assert.throws(
    () => reconcileGoalActivation(fixture.bridgeRoot, fixture.plan.operationId, differing),
    /refuses to overwrite or clear/,
  );
  assert.equal(loadOperationJournal(fixture.bridgeRoot, fixture.plan.operationId).state, "reconciliation-required");
});

test("a fence-bearing worker survives parent death and excludes recovery until worker exit", {
  skip: process.platform !== "win32" ? "Windows process-tree fencing test" : false,
  timeout: 20_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-parent-death-"));
  const codexHome = path.join(root, "codex");
  const appRoot = path.join(root, "private-app");
  fs.mkdirSync(codexHome);
  const fence = codexGoalTargetTesting.prepareFence(codexHome, appRoot);
  const ready = path.join(root, "worker.ready");
  const workerPidFile = path.join(root, "worker.pid");
  const holder = String.raw`
const fs = require("node:fs"); const { DatabaseSync } = require("node:sqlite");
const [fence, ready] = process.argv.slice(1); const db = new DatabaseSync(fence);
db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); fs.writeFileSync(ready, "ready"); setInterval(() => {}, 1000);
`;
  const parentScript = String.raw`
const fs = require("node:fs"); const { spawn } = require("node:child_process");
const [fence, ready, pidFile, holder] = process.argv.slice(1);
const worker = spawn(process.execPath, ["--experimental-sqlite", "-e", holder, fence, ready], { detached: true, stdio: "ignore" });
fs.writeFileSync(pidFile, String(worker.pid)); worker.unref(); setInterval(() => {}, 1000);
`;
  const parent = spawn(process.execPath, ["-e", parentScript, fence, ready, workerPidFile, holder], {
    detached: false, stdio: "ignore",
  });
  try {
    await waitUntil(() => fs.existsSync(ready) && fs.existsSync(workerPidFile));
    const workerPid = Number(fs.readFileSync(workerPidFile, "utf8"));
    process.kill(parent.pid!, "SIGTERM");
    await new Promise((resolve) => parent.once("exit", resolve));
    process.kill(workerPid, 0);
    const recovery = new DatabaseSync(fence);
    try {
      recovery.exec("PRAGMA busy_timeout = 0");
      assert.throws(() => recovery.exec("BEGIN EXCLUSIVE"), /locked|busy/i);
    } finally { recovery.close(); }
    process.kill(workerPid, "SIGTERM");
    await waitUntil(() => {
      const retry = new DatabaseSync(fence);
      try { retry.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK"); return true; }
      catch { return false; }
      finally { retry.close(); }
    });
  } finally {
    try { process.kill(parent.pid!, "SIGTERM"); } catch { /* already stopped */ }
  }
});

test("recovery-first fence makes a competing worker perform zero set mutations", {
  skip: process.platform !== "win32" ? "Windows recovery fence test" : false,
  timeout: 10_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-recovery-first-"));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome);
  const fence = codexGoalTargetTesting.prepareFence(codexHome, path.join(root, "private-app"));
  const setMarker = path.join(root, "set.called");
  const recovery = new DatabaseSync(fence);
  recovery.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  const contenderScript = String.raw`
const fs = require("node:fs"); const { DatabaseSync } = require("node:sqlite");
const [fence, marker] = process.argv.slice(1); const db = new DatabaseSync(fence);
db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); fs.writeFileSync(marker, "set");
`;
  const contender = spawn(process.execPath, ["--experimental-sqlite", "-e", contenderScript, fence, setMarker], {
    stdio: "ignore",
  });
  const exitCode = await new Promise<number | null>((resolve) => contender.once("exit", resolve));
  recovery.exec("ROLLBACK"); recovery.close();
  assert.notEqual(exitCode, 0);
  assert.equal(fs.existsSync(setMarker), false, "set body must not run before acquiring the recovery fence");
});

test("recovery cancellation defeats a delayed worker nonce, stale replay, and cross-operation cancellation", {
  skip: process.platform !== "win32" ? "Windows durable Goal generation test" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-generation-"));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome);
  const fence = codexGoalTargetTesting.prepareFence(codexHome, path.join(root, "private-app"));
  const threadId = "thread-generation";
  const binding = {
    operationId: "operation-generation",
    targetThreadId: threadId,
    capabilityId: CODEX_GOAL_TARGET_CAPABILITY_ID,
    profileFingerprint: CODEX_GOAL_TARGET_FINGERPRINT,
  };
  const staleNonce = codexGoalTargetTesting.reserveSet(fence, binding);
  // Recovery acquires the same exclusive fence, commits cancellation, and
  // releases it before the delayed worker is finally scheduled.
  codexGoalTargetTesting.cancelSet(fence, binding);
  const delayed = new DatabaseSync(fence);
  try {
    delayed.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    const staleClaim = delayed.prepare(`
      UPDATE set_invocations_v2 SET state = 'claimed'
      WHERE thread_id = ? AND operation_id = ? AND capability_id = ? AND profile_fingerprint = ?
        AND nonce = ? AND state = 'pending'
    `).run(threadId, binding.operationId, binding.capabilityId, binding.profileFingerprint, staleNonce);
    assert.equal(staleClaim.changes, 0, "cancelled delayed worker must perform zero set work");
    delayed.exec("ROLLBACK");
  } finally { delayed.close(); }

  const currentNonce = codexGoalTargetTesting.reserveSet(fence, binding);
  assert.notEqual(currentNonce, staleNonce);
  const db = new DatabaseSync(fence);
  try {
    db.exec("BEGIN EXCLUSIVE");
    const staleReplay = db.prepare(`
      UPDATE set_invocations_v2 SET state = 'claimed'
      WHERE thread_id = ? AND nonce = ? AND state = 'pending'
    `).run(threadId, staleNonce);
    const currentClaim = db.prepare(`
      UPDATE set_invocations_v2 SET state = 'claimed'
      WHERE thread_id = ? AND nonce = ? AND state = 'pending'
    `).run(threadId, currentNonce);
    const replay = db.prepare(`
      UPDATE set_invocations_v2 SET state = 'claimed'
      WHERE thread_id = ? AND nonce = ? AND state = 'pending'
    `).run(threadId, currentNonce);
    assert.equal(staleReplay.changes, 0);
    assert.equal(currentClaim.changes, 1);
    assert.equal(replay.changes, 0);
    db.exec("ROLLBACK");
  } finally { db.close(); }

  assert.throws(() => codexGoalTargetTesting.cancelSet(fence, {
    ...binding, operationId: "different-operation",
  }), /different operation or capability/);
  codexGoalTargetTesting.cancelSet(fence, {
    ...binding, targetThreadId: "different-thread",
  });
  const unchanged = new DatabaseSync(fence);
  try {
    const row = unchanged.prepare("SELECT state FROM set_invocations_v2 WHERE thread_id = ?").get(threadId) as { state: string };
    assert.equal(row.state, "pending", "cross-thread cancellation must not touch the reserved thread");
  } finally { unchanged.close(); }

  const hardDeathBinding = { ...binding, operationId: "hard-death-operation", targetThreadId: "hard-death-thread" };
  const hardDeathNonce = codexGoalTargetTesting.reserveSet(fence, hardDeathBinding);
  const deadWorker = new DatabaseSync(fence);
  try {
    deadWorker.exec("BEGIN EXCLUSIVE");
    const claimed = deadWorker.prepare(`
      UPDATE set_invocations_v2 SET state = 'claimed'
      WHERE thread_id = ? AND nonce = ? AND state = 'pending'
    `).run(hardDeathBinding.targetThreadId, hardDeathNonce);
    assert.equal(claimed.changes, 1);
    deadWorker.exec("COMMIT");
  } finally { deadWorker.close(); }
  assert.throws(
    () => codexGoalTargetTesting.cancelSet(fence, hardDeathBinding),
    /cannot prove its app-server child is dead/,
    "a hard-dead fence owner leaves a durable claimed tombstone and blocks destructive recovery",
  );
});

test("privacy setup failure occurs before any app-server worker spawn", {
  skip: installedCanarySkipReason(),
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-private-fail-"));
  const codexHome = path.join(root, "codex");
  const realRoot = path.join(root, "real-private-root");
  const linkedRoot = path.join(root, "linked-private-root");
  fs.mkdirSync(codexHome); fs.mkdirSync(realRoot); fs.symlinkSync(realRoot, linkedRoot, "junction");
  const evidence = loadInstalledCodexTargetEvidence(path.resolve("reference/codex-desktop/26.721.41059/manifest.json"));
  let workerSpawns = 0;
  assert.throws(() => codexGoalTargetTesting.createRpc(evidence, codexHome, linkedRoot, () => {
    workerSpawns += 1;
    throw new Error("worker should not start");
  }), /symlink|reparse/i);
  assert.equal(workerSpawns, 0);
});

test("fence validation rejects Codex-home identity drift and reparse traversal", {
  skip: process.platform !== "win32" ? "Windows fence identity test" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-fence-identity-"));
  const codexHome = path.join(root, "codex");
  const appRoot = path.join(root, "private-app");
  fs.mkdirSync(codexHome);
  const fence = codexGoalTargetTesting.prepareFence(codexHome, appRoot);
  const db = new DatabaseSync(fence);
  try { db.prepare("UPDATE target_binding SET codex_home = ? WHERE singleton = 1").run(path.join(root, "other")); }
  finally { db.close(); }
  assert.throws(() => codexGoalTargetTesting.prepareFence(codexHome, appRoot), /different Codex home/);
  const alias = path.join(root, "codex-link");
  fs.symlinkSync(codexHome, alias, "junction");
  assert.throws(() => codexGoalTargetTesting.prepareFence(alias, path.join(root, "other-private-app")), /symlink|reparse/i);
});

function installedCanarySkipReason(): string | false {
  if (process.platform !== "win32") return "exact 26.721.41059 Desktop runtime canary is Windows-only";
  const manifest = path.resolve("reference/codex-desktop/26.721.41059/manifest.json");
  if (!fs.existsSync(manifest)) return "version-pinned manifest is unavailable";
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { artifacts?: Array<{ source_path?: string }> };
    const exe = parsed.artifacts?.find((item) => /codex\.exe$/i.test(item.source_path ?? ""))?.source_path;
    return exe && fs.existsSync(exe) ? false : "exact installed codex.exe is unavailable";
  } catch { return "version-pinned manifest cannot be read"; }
}

test("a later importer reaps an exact stale lease when its PID was reused", {
  skip: installedCanarySkipReason(),
  timeout: 60_000,
}, () => {
  const evidence = loadInstalledCodexTargetEvidence(path.resolve("reference/codex-desktop/26.721.41059/manifest.json"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-stale-lease-"));
  const appRoot = path.join(root, "private-app");
  const runtimeRoot = path.join(appRoot, "runtime-leases");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  codexGoalTargetTesting.protectDirectory(appRoot);
  codexGoalTargetTesting.protectDirectory(runtimeRoot);
  for (const name of ["lease-aaaPreserved", "lease-bbbPreserved"]) {
    const preserved = path.join(runtimeRoot, name);
    fs.mkdirSync(preserved);
    codexGoalTargetTesting.protectDirectory(preserved);
  }
  const staleRoot = path.join(runtimeRoot, "lease-zzzStaleOwner");
  fs.mkdirSync(staleRoot);
  codexGoalTargetTesting.protectDirectory(staleRoot);
  const sha = evidence.codexExeSha256.toLowerCase();
  const executable = path.join(staleRoot, `${sha}.exe`);
  fs.copyFileSync(evidence.codexExePath!, executable);
  codexGoalTargetTesting.protectFile(executable);
  const markerPath = path.join(staleRoot, "lease.json");
  fs.writeFileSync(markerPath, `${JSON.stringify({
    schema: "pass-the-thread/runtime-lease-v2",
    directory: path.basename(staleRoot),
    ownerPid: process.pid,
    ownerStartedAtMs: 1,
    createdAtMs: Date.now() - 60_000,
    executableSha256: sha,
  })}\n`);
  codexGoalTargetTesting.protectFile(markerPath);
  const first = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 30_000,
    maxCandidates: 2,
  });
  assert.deepEqual(first, { examined: 2, cleaned: 0, deferred: true });
  assert.equal(fs.existsSync(staleRoot), true);
  const second = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 30_000,
    maxCandidates: 2,
  });
  assert.equal(second.cleaned, 1);
  assert.equal(fs.existsSync(staleRoot), false,
    "the persistent cursor must reach a stale lease behind preserved entries");
});

test("runtime lease reaping defers accumulated candidates at both count and time budgets", {
  skip: process.platform !== "win32" ? "runtime lease DACL contract is Windows-only" : false,
  timeout: 30_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-reaper-budget-"));
  const runtimeRoot = path.join(root, "runtime-leases");
  fs.mkdirSync(runtimeRoot);
  codexGoalTargetTesting.protectDirectory(runtimeRoot);
  for (let index = 0; index < 6; index += 1) {
    const candidate = path.join(runtimeRoot, `lease-candidate${index}`);
    fs.mkdirSync(candidate);
    codexGoalTargetTesting.protectDirectory(candidate);
  }

  const countBound = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 30_000,
    maxCandidates: 2,
  });
  assert.deepEqual(countBound, { examined: 2, cleaned: 0, deferred: true });

  let clockReads = 0;
  const timeBound = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 10,
    maxCandidates: 100,
    now: () => clockReads++ === 0 ? 0 : 11,
  });
  assert.deepEqual(timeBound, { examined: 0, cleaned: 0, deferred: true });
});

test("transactional cursor rolls back interrupted advances and serializes concurrent reapers", {
  skip: process.platform !== "win32" ? "runtime lease DACL contract is Windows-only" : false,
  timeout: 30_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-cursor-transaction-"));
  const runtimeRoot = path.join(root, "runtime-leases");
  fs.mkdirSync(runtimeRoot);
  codexGoalTargetTesting.protectDirectory(runtimeRoot);
  for (const name of ["lease-aaa", "lease-bbb"]) fs.mkdirSync(path.join(runtimeRoot, name));

  const interrupted = codexGoalTargetTesting.beginRuntimeLeaseCursor(runtimeRoot, 10_000);
  interrupted.advance("lease-aaa");
  interrupted.close(false);
  const visitedAfterRollback: string[] = [];
  codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 10_000,
    maxCandidates: 1,
    inspectCandidate: (name) => { visitedAfterRollback.push(name); },
  });
  assert.deepEqual(visitedAfterRollback, ["lease-aaa"]);

  const holder = codexGoalTargetTesting.beginRuntimeLeaseCursor(runtimeRoot, 10_000);
  const blocked = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 1_000,
    maxCandidates: 1,
    inspectCandidate: () => { assert.fail("a concurrent reaper must not inspect without the cursor lock"); },
  });
  assert.deepEqual(blocked, { examined: 0, cleaned: 0, deferred: true });
  holder.close(false);

  let gapHolder: ReturnType<typeof codexGoalTargetTesting.beginRuntimeLeaseCursor> | undefined;
  const contentionStartedAt = Date.now();
  const gapContended = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 3_000,
    maxCandidates: 1,
    inspectCandidate: () => { assert.fail("deadline-bounded reacquisition must not reach inspection"); },
    afterStageCommit: () => {
      gapHolder = codexGoalTargetTesting.beginRuntimeLeaseCursor(runtimeRoot, 10_000);
    },
  });
  const contentionElapsedMs = Date.now() - contentionStartedAt;
  gapHolder?.close(false);
  assert.deepEqual(gapContended, { examined: 0, cleaned: 0, deferred: true });
  assert.ok(contentionElapsedMs < 6_000,
    `cursor reacquisition exceeded its remaining deadline: ${contentionElapsedMs}ms`);
});

test("an abandoned fully initialized cursor stage is safely reaped before atomic publication", {
  skip: process.platform !== "win32" ? "runtime lease DACL contract is Windows-only" : false,
  timeout: 30_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-cursor-publication-"));
  const runtimeRoot = path.join(root, "runtime-leases");
  fs.mkdirSync(runtimeRoot);
  codexGoalTargetTesting.protectDirectory(runtimeRoot);
  fs.mkdirSync(path.join(runtimeRoot, "lease-candidate"));
  const partialCreatedAt = Date.now() - 120_000;
  for (let index = 0; index < 4; index += 1) {
    const partial = path.join(runtimeRoot,
      `reaper-stage-${partialCreatedAt + index}-${process.pid}-00000000-0000-4000-8000-00000000000${index}.sqlite`);
    fs.writeFileSync(partial, "partial");
    codexGoalTargetTesting.protectFile(partial);
  }
  const stage = codexGoalTargetTesting.prepareAbandonedRuntimeLeaseCursorStage(runtimeRoot, 10_000, {
    ownerPid: process.pid,
    ownerStartedAtMs: 1,
    createdAtMs: Date.now() - 60_000,
  });
  assert.equal(fs.existsSync(path.join(runtimeRoot, "reaper.sqlite")), false,
    "a pre-publication crash must not expose the final cursor path");

  const visited: string[] = [];
  const result = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 15_000,
    maxCandidates: 1,
    inspectCandidate: (name) => { visited.push(name); },
  });
  assert.equal(result.examined, 1);
  assert.deepEqual(visited, ["lease-candidate"]);
  assert.equal(fs.existsSync(stage), true,
    "four preserved prefix stages consume only the first bounded stage pass");
  codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 15_000,
    maxCandidates: 1,
    inspectCandidate: () => {},
  });
  assert.equal(fs.existsSync(stage), false,
    "the persistent stage cursor must reach and remove the later exact abandoned stage");
  assert.equal(fs.existsSync(path.join(runtimeRoot, "reaper.sqlite")), true,
    "the next invocation must atomically publish a complete cursor");
});

test("deadline-bound enumeration advances through more than 256 leases", {
  skip: process.platform !== "win32" ? "runtime lease cursor contract is Windows-only" : false,
  timeout: 30_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-many-leases-"));
  const runtimeRoot = path.join(root, "runtime-leases");
  fs.mkdirSync(runtimeRoot);
  codexGoalTargetTesting.protectDirectory(runtimeRoot);
  for (let index = 0; index < 300; index += 1) {
    fs.mkdirSync(path.join(runtimeRoot, `lease-${String(index).padStart(3, "0")}`));
  }
  const visited = new Set<string>();
  for (let pass = 0; pass < 3; pass += 1) {
    const result = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
      budgetMs: 10_000,
      maxCandidates: 100,
      inspectCandidate: (name) => { visited.add(name); },
    });
    assert.equal(result.examined, 100);
  }
  assert.equal(visited.size, 300);
  assert.ok(visited.has("lease-299"));
});

test("runtime lease reaping never starts cleanup after its deadline expires mid-candidate", {
  skip: process.platform !== "win32" ? "runtime lease DACL contract is Windows-only" : false,
  timeout: 30_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-reaper-deadline-"));
  const runtimeRoot = path.join(root, "runtime-leases");
  const staleRoot = path.join(runtimeRoot, "lease-deadline");
  fs.mkdirSync(staleRoot, { recursive: true });
  codexGoalTargetTesting.protectDirectory(runtimeRoot);
  codexGoalTargetTesting.protectDirectory(staleRoot);
  const markerPath = path.join(staleRoot, "lease.json");
  fs.writeFileSync(markerPath, `${JSON.stringify({
    schema: "pass-the-thread/runtime-lease-v2",
    directory: path.basename(staleRoot),
    ownerPid: process.pid,
    ownerStartedAtMs: 1,
    createdAtMs: 1,
    executableSha256: "a".repeat(64),
  })}\n`);
  codexGoalTargetTesting.protectFile(markerPath);

  let expired = false;
  const result = codexGoalTargetTesting.reapRuntimeLeases(runtimeRoot, {
    budgetMs: 30_000,
    maxCandidates: 1,
    now: () => expired ? 90_001 : 60_000,
    beforeCleanup: () => { expired = true; },
  });
  assert.deepEqual(result, { examined: 1, cleaned: 0, deferred: true });
  assert.equal(fs.existsSync(staleRoot), true);
  assert.equal(fs.existsSync(markerPath), true);
});

for (const hardKillAttempt of [1, 2]) test(`hard-killing the production worker after native set leaves no lease (attempt ${hardKillAttempt})`, {
  skip: installedCanarySkipReason(),
  timeout: 120_000,
}, async () => {
  const evidence = loadInstalledCodexTargetEvidence(path.resolve("reference/codex-desktop/26.721.41059/manifest.json"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-hard-worker-"));
  const initial = createCodexGoalRpc(evidence, codexHome);
  try { initial.probe(); } finally { initial.dispose(); }
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const plan = planCodexTarget(codexHome, dbPath, "hard-worker", "c".repeat(64), {
    cwd: codexHome, title: "hard worker", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user", text: "hard worker" }],
  });
  fs.mkdirSync(path.dirname(plan.rolloutPath), { recursive: true });
  fs.writeFileSync(plan.rolloutPath, plan.serializedRollout);
  registerCodexThread41059(dbPath, {
    id: plan.threadId, rolloutPath: plan.rolloutPath, cwd: codexHome, title: "hard worker",
    createdAtMs: Date.parse(plan.conversation.createdAt), updatedAtMs: Date.parse(plan.conversation.createdAt),
    archived: false, firstUserMessage: "hard worker", preview: "hard worker",
  });
  const auditPath = path.join(codexHome, "set-sent.json");
  const binding = {
    operationId: "hard-worker-operation",
    targetThreadId: plan.threadId,
    capabilityId: CODEX_GOAL_TARGET_CAPABILITY_ID,
    profileFingerprint: CODEX_GOAL_TARGET_FINGERPRINT,
  };
  const expected = { threadId: plan.threadId, objective: "hard worker canary", status: "active" as const, tokenBudget: null };
  const childScript = String.raw`
const [moduleUrl, evidenceText, codexHome, auditPath, expectedText, bindingText] = process.argv.slice(1);
const mod = await import(moduleUrl);
const rpc = mod.codexGoalTargetTesting.createProductionRpcWithControl(
  JSON.parse(evidenceText), codexHome, { afterSetSentPath: auditPath, holdAfterSetSentMs: 60000 },
);
try { rpc.set(JSON.parse(expectedText), JSON.parse(bindingText)); } finally { rpc.dispose(); }
`;
  const importer = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "-e", childScript,
    pathToFileURL(path.resolve("src/codex-goal-target.ts")).href, JSON.stringify(evidence), codexHome, auditPath,
    JSON.stringify(expected), JSON.stringify(binding)], { stdio: "ignore" });
  let childPid: number | null = null;
  let ownedLease: string | null = null;
  try {
    await waitUntil(() => fs.existsSync(auditPath), 30_000);
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8")) as { workerPid: number; childPid: number; executable: string };
    childPid = audit.childPid;
    ownedLease = path.dirname(audit.executable);
    execFileSync("taskkill.exe", ["/PID", String(audit.workerPid), "/F"], { windowsHide: true, stdio: "ignore" });
    try { execFileSync("taskkill.exe", ["/PID", String(audit.childPid), "/F"], { windowsHide: true, stdio: "ignore" }); }
    catch { /* app-server may already have exited when its stdin closed */ }
    const recovery = createCodexGoalRpc(evidence, codexHome);
    try {
      assert.throws(
        () => recovery.get(plan.threadId, binding),
        /cannot prove its app-server child is dead/,
      );
    } finally { recovery.dispose(); }
  } finally {
    if (childPid != null) {
      try { execFileSync("taskkill.exe", ["/PID", String(childPid), "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* gone */ }
    }
    if (importer.exitCode == null) {
      await Promise.race([
        new Promise((resolve) => importer.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    if (importer.exitCode == null) {
      try { process.kill(importer.pid!, "SIGTERM"); } catch { /* already exited */ }
      await new Promise((resolve) => importer.once("exit", resolve));
    }
  }
  assert.ok(ownedLease != null);
  await waitUntil(() => !fs.existsSync(ownedLease!), 10_000);
});

test("exact 41059 app-server Goal survives restart without changing rollout", {
  skip: installedCanarySkipReason(),
  timeout: 120_000,
}, () => {
  const evidence = loadInstalledCodexTargetEvidence(path.resolve("reference/codex-desktop/26.721.41059/manifest.json"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-runtime-canary-"));
  const auditPath = path.join(codexHome, "runtime-lease.json");
  const rpc = codexGoalTargetTesting.createProductionRpcWithControl(evidence, codexHome, {
    afterSetSentPath: auditPath, holdAfterSetSentMs: 0,
  });
  let ownedLease: string | null = null;
  try {
    rpc.probe();
    const dbPath = path.join(codexHome, "state_5.sqlite");
    const plan = planCodexTarget(codexHome, dbPath, "runtime-canary", "b".repeat(64), {
      cwd: codexHome, title: "runtime canary", createdAt: "2026-07-26T00:00:00.000Z",
      messages: [{ role: "user", text: "canary" }],
    });
    fs.mkdirSync(path.dirname(plan.rolloutPath), { recursive: true });
    fs.writeFileSync(plan.rolloutPath, plan.serializedRollout);
    registerCodexThread41059(dbPath, {
      id: plan.threadId, rolloutPath: plan.rolloutPath, cwd: codexHome, title: "runtime canary",
      createdAtMs: Date.parse(plan.conversation.createdAt), updatedAtMs: Date.parse(plan.conversation.createdAt),
      archived: false, firstUserMessage: "canary", preview: "canary",
    });
    const before = createHash("sha256").update(fs.readFileSync(plan.rolloutPath)).digest("hex");
    const binding = {
      operationId: "runtime-canary",
      targetThreadId: plan.threadId,
      capabilityId: CODEX_GOAL_TARGET_CAPABILITY_ID,
      profileFingerprint: CODEX_GOAL_TARGET_FINGERPRINT,
    };
    assert.equal(rpc.get(plan.threadId, binding), null);
    const expected = { threadId: plan.threadId, objective: "runtime restart canary", status: "active" as const, tokenBudget: 4321 };
    const set = rpc.set(expected, binding);
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8")) as { executable: string };
    ownedLease = path.dirname(audit.executable);
    assertCodexGoalReadback(set, expected);
    const afterRestart = rpc.get(plan.threadId, binding);
    assert.deepEqual(afterRestart, set);
    assert.equal(createHash("sha256").update(fs.readFileSync(plan.rolloutPath)).digest("hex"), before);
  } finally { rpc.dispose(); }
  assert.ok(ownedLease != null);
  assert.equal(fs.existsSync(ownedLease), false, "the canary's exact runtime lease must be removed");
});
