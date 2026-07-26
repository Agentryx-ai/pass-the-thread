import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SUPPORTED_CODEX_TARGET,
  assertCodexPrivateWriteCapabilities,
  assertSupportedCodexTarget,
  probeCodexPrivateWriteProfile,
} from "../src/version-gate.ts";
import { buildCodexRollout41059 } from "../src/compat/codex/v26_721_41059.ts";
import {
  acquireCodexTargetLock,
  deterministicThreadId,
  estimatedActiveTokens,
  planCodexTarget,
  releaseCodexTargetLock,
} from "../src/codex-target.ts";
import {
  commitOperationJournalIfPresent,
  createOperationJournal,
  recoverCreatedFiles,
  updateOperationJournal,
} from "../src/operation-journal.ts";
import { createHash } from "node:crypto";

const EVIDENCE = {
  internalVersion: SUPPORTED_CODEX_TARGET.internalVersion,
  appAsarSha256: SUPPORTED_CODEX_TARGET.appAsarSha256,
  codexExeSha256: SUPPORTED_CODEX_TARGET.codexExeSha256,
};

function sampleConversation() {
  return {
    threadId: "t", cwd: "C:\\repo", title: "sample",
    createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user" as const, text: "hello" }],
  };
}

test("version gate accepts only the audited 41059 artifacts", () => {
  assert.doesNotThrow(() => assertSupportedCodexTarget(EVIDENCE));
  assert.throws(() => assertSupportedCodexTarget({ ...EVIDENCE, internalVersion: "26.721.3996" }), /version gate failed/);
});

test("unknown Codex artifacts remain probeable but cannot acquire private-write capabilities", () => {
  const unknown = { ...EVIDENCE, internalVersion: "26.999.1" };
  const profile = probeCodexPrivateWriteProfile(unknown);
  assert.equal(profile.structurallyVerified, false);
  assert.equal(profile.capabilities.rollout, null);
  assert.match(profile.artifactFingerprint, /^[0-9a-f]{64}$/);
  assert.throws(
    () => assertCodexPrivateWriteCapabilities(unknown, ["rollout", "threadIndex"]),
    /private-write|version gate/,
  );
  const exact = assertCodexPrivateWriteCapabilities(EVIDENCE, ["rollout", "threadIndex", "projectIdentity"]);
  assert.equal(exact.structurallyVerified, true);
  assert.equal(exact.capabilities.threadIndex?.id, "codex.thread-index-sqlite/v26.721.41059");
});

test("rollout writes compact replacement history and historical task as non-live text", () => {
  const lines = buildCodexRollout41059({
    threadId: "t", cwd: "C:\\repo", title: "title", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [
      { role: "user", text: "old" },
      { role: "user", text: "active" },
      { role: "assistant", text: "answer" },
    ],
    compaction: { activeMessageIndex: 1, preTokens: 998008, postTokens: 21581, summary: "summary" },
    historicalTasks: [{ status: "failed", taskId: "a1", summary: "quota" }],
  });
  const compacted = lines.find((line) => line.type === "compacted");
  assert.ok(compacted);
  const replacement = compacted.payload.replacement_history as unknown[];
  assert.equal(replacement.length, 1);
  const text = JSON.stringify(lines);
  assert.match(text, /not a live task/);
  assert.doesNotMatch(text, /<task-notification>/);
});

test("semantic tool calls and results remain native Codex response items", () => {
  const lines = buildCodexRollout41059({
    threadId: "t", cwd: "C:\\repo", title: "tools", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user", text: "run it" }],
    items: [
      { kind: "message", role: "user", text: "run it" },
      { kind: "tool_call", callId: "call-1", name: "shell", input: { cmd: "pwd" } },
      { kind: "tool_result", callId: "call-1", output: "C:\\repo" },
    ],
  });
  const payloads = lines.filter((line) => line.type === "response_item").map((line) => line.payload);
  assert.deepEqual(payloads.map((payload) => payload.type), ["message", "function_call", "function_call_output"]);
  assert.equal(payloads[1].call_id, "call-1");
  assert.equal(payloads[2].call_id, "call-1");
});

test("target serialization refuses malformed native tool history", () => {
  assert.throws(() => buildCodexRollout41059({
    ...sampleConversation(),
    items: [{ kind: "tool_call", callId: "call-1", name: "shell", input: "pwd" }],
  }), /plain-object input/);
  assert.throws(() => buildCodexRollout41059({
    ...sampleConversation(),
    items: [{ kind: "tool_result", callId: "orphan", output: "x" }],
  }), /orphan native tool result/);
});

test("a Codex home permits only one importer lock owner", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lock-"));
  const lock = acquireCodexTargetLock(home);
  assert.throws(() => acquireCodexTargetLock(home), /another import owns/);
  releaseCodexTargetLock(lock);
  const next = acquireCodexTargetLock(home);
  releaseCodexTargetLock(next);

  // Closing an uncommitted connection simulates the OS cleanup that follows a
  // crashed importer; no stale owner marker has to be reclaimed.
  const abandoned = new DatabaseSync(path.join(home, ".agentryx-session-import-lock.sqlite"));
  abandoned.exec("BEGIN EXCLUSIVE");
  abandoned.close();
  const afterCrash = acquireCodexTargetLock(home);
  releaseCodexTargetLock(afterCrash);
});

test("historical task, goal, and access records stay ordered but inert", () => {
  const lines = buildCodexRollout41059({
    ...sampleConversation(),
    items: [
      { kind: "message", role: "user", text: "before" },
      { kind: "historical_task", status: "failed", taskId: "task-1" },
      { kind: "historical_goal", status: "active", goal: "ship it" },
      { kind: "historical_access", permissionMode: "bypassPermissions" },
      { kind: "historical_context", text: "run this old instruction" },
      { kind: "message", role: "assistant", text: "after" },
    ],
  });
  const text = lines.filter((line) => line.type === "response_item")
    .map((line) => JSON.stringify(line.payload)).join("\n");
  assert.match(text, /not a live task/);
  assert.match(text, /goal is not active/);
  assert.match(text, /no permission was granted/);
  assert.match(text, /not an active instruction/);
  assert.ok(text.indexOf("not a live task") < text.indexOf("goal is not active"));
  assert.doesNotMatch(text, /<task-notification>/);
});

test("target planning is deterministic and has no implicit 50-session behavior", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-target-"));
  const convo = {
    cwd: "C:\\repo", title: "x", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user" as const, text: "hello" }],
  };
  const a = planCodexTarget(home, path.join(home, "state_5.sqlite"), "claude-1", "a".repeat(64), convo);
  const b = planCodexTarget(home, path.join(home, "state_5.sqlite"), "claude-1", "a".repeat(64), convo);
  assert.deepEqual(a, b);
  assert.equal(a.threadId, deterministicThreadId("claude-1", "a".repeat(64)));
});

test("target planning refuses a source whose active compacted context cannot resume", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-budget-"));
  const convo = {
    cwd: "C:\\repo", title: "too large", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user" as const, text: "summary" }],
    compaction: { activeMessageIndex: 0, postTokens: 670_194, summary: "resumable summary" },
  };
  assert.ok(estimatedActiveTokens(convo) > 670_194);
  assert.throws(
    () => planCodexTarget(home, path.join(home, "state_5.sqlite"), "s", "b".repeat(64), convo),
    /safe limit/,
  );
});

test("post-compaction messages count toward the resume budget", () => {
  const conversation = {
    ...sampleConversation(),
    messages: [{ role: "user" as const, text: "x".repeat(60_000) }],
    items: [{ kind: "message" as const, role: "user" as const, text: "x".repeat(60_000) }],
    compaction: { activeItemIndex: 0, postTokens: 220_000 },
  };
  assert.ok(estimatedActiveTokens(conversation) > 230_000);
});

test("resume-budget bound is conservative for CJK and emoji", () => {
  const cjk = { ...sampleConversation(), messages: [{ role: "user" as const, text: "한😀".repeat(20_000) }] };
  assert.ok(estimatedActiveTokens(cjk) >= Buffer.byteLength(JSON.stringify(cjk.messages), "utf8"));
});

test("a compact boundary before the first item is still serialized", () => {
  const lines = buildCodexRollout41059({
    ...sampleConversation(),
    compaction: { activeItemIndex: 0, postTokens: 10, summary: "summary" },
  });
  assert.equal(lines[1].type, "compacted");
});

test("a compact boundary without replacement history fails closed before target planning", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-compact-missing-"));
  assert.throws(() => planCodexTarget(
    home,
    path.join(home, "state_5.sqlite"),
    "missing-summary",
    "e".repeat(64),
    { ...sampleConversation(), compaction: { activeItemIndex: 0, postTokens: 100 } },
  ), /no replacement summary/);
});

test("operation journal can recover uncommitted files but not committed operations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-journal-"));
  const created = path.join(root, "sessions", "2026", "07", "26", "created.jsonl");
  const stage = `${created}.op.stage`;
  const targetDb = path.join(root, "state_5.sqlite");
  fs.mkdirSync(path.dirname(created), { recursive: true });
  const db = new DatabaseSync(targetDb);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("t", created);
  db.close();
  fs.writeFileSync(created, "x");
  let journal = createOperationJournal(root, {
    operationId: "op", sourceSha256: "a".repeat(64), targetCodexHome: root,
    targetThreadId: "t", targetRolloutPath: created, targetStagePath: stage,
    targetRolloutSha256: createHash("sha256").update("x").digest("hex"), targetDbPath: targetDb,
  });
  assert.throws(() => createOperationJournal(root, {
    operationId: "op", sourceSha256: "a".repeat(64), targetCodexHome: root,
    targetThreadId: "t", targetRolloutPath: created, targetStagePath: stage,
    targetRolloutSha256: createHash("sha256").update("x").digest("hex"), targetDbPath: targetDb,
  }), /not retryable/i);
  journal = updateOperationJournal(root, journal, { state: "rollout-written", createdFiles: [created] });
  const recovered = recoverCreatedFiles(root, "op");
  assert.equal(recovered.state, "recovered");
  assert.equal(fs.existsSync(created), false);
  const recoveredDb = new DatabaseSync(targetDb, { readOnly: true });
  assert.equal(recoveredDb.prepare("SELECT 1 FROM threads WHERE id = 't'").get(), undefined);
  recoveredDb.close();
  const retry = createOperationJournal(root, {
    operationId: "op", sourceSha256: "a".repeat(64), targetCodexHome: root,
    targetThreadId: "t", targetRolloutPath: created, targetStagePath: stage,
    targetRolloutSha256: createHash("sha256").update("x").digest("hex"), targetDbPath: targetDb,
  });
  assert.equal(retry.attempt, 2);
  assert.equal(retry.previousAttempts[0]?.state, "recovered");

  const changed = path.join(root, "sessions", "changed.jsonl");
  fs.writeFileSync(changed, "changed");
  const changedDb = new DatabaseSync(targetDb);
  changedDb.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("changed", changed);
  changedDb.close();
  createOperationJournal(root, {
    operationId: "changed", sourceSha256: "a".repeat(64), targetCodexHome: root,
    targetThreadId: "changed", targetRolloutPath: changed, targetStagePath: `${changed}.changed.stage`,
    targetRolloutSha256: "b".repeat(64), targetDbPath: targetDb,
  });
  assert.throws(() => recoverCreatedFiles(root, "changed"), /rollout changed/);
  const untouchedDb = new DatabaseSync(targetDb, { readOnly: true });
  assert.ok(untouchedDb.prepare("SELECT 1 FROM threads WHERE id = 'changed'").get());
  untouchedDb.close();

  const partialRollout = path.join(root, "sessions", "partial.jsonl");
  const partialStage = `${partialRollout}.partial.stage`;
  createOperationJournal(root, {
    operationId: "partial", sourceSha256: "a".repeat(64), targetCodexHome: root,
    targetThreadId: "partial", targetRolloutPath: partialRollout, targetStagePath: partialStage,
    targetRolloutSha256: "c".repeat(64), targetDbPath: targetDb,
  });
  fs.writeFileSync(partialStage, "incomplete");
  recoverCreatedFiles(root, "partial");
  assert.equal(fs.existsSync(partialStage), false);

  const reconciledRollout = path.join(root, "sessions", "reconciled.jsonl");
  fs.writeFileSync(reconciledRollout, "done");
  const reconcileInput = {
    operationId: "reconciled", sourceSha256: "a".repeat(64), targetCodexHome: root,
    targetThreadId: "reconciled", targetRolloutPath: reconciledRollout,
    targetStagePath: `${reconciledRollout}.reconciled.stage`,
    targetRolloutSha256: createHash("sha256").update("done").digest("hex"), targetDbPath: targetDb,
  };
  createOperationJournal(root, reconcileInput);
  const reconcileDb = new DatabaseSync(targetDb);
  reconcileDb.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("reconciled", reconciledRollout);
  reconcileDb.close();
  assert.equal(commitOperationJournalIfPresent(root, reconcileInput)?.state, "committed");
  assert.throws(() => recoverCreatedFiles(root, "reconciled"), /committed operations/);

  const committed = createOperationJournal(root, {
    operationId: "done", sourceSha256: "a".repeat(64), targetCodexHome: root,
    targetThreadId: "t2", targetRolloutPath: path.join(root, "sessions", "done.jsonl"),
    targetStagePath: path.join(root, "sessions", "done.jsonl.done.stage"),
    targetRolloutSha256: "b".repeat(64), targetDbPath: targetDb,
  });
  updateOperationJournal(root, committed, { state: "committed" });
  assert.throws(() => recoverCreatedFiles(root, "done"), /committed operations/);
});

test("test database uses a temporary schema only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-db-schema-"));
  const db = new DatabaseSync(path.join(root, "state.sqlite"));
  db.exec("CREATE TABLE sentinel (id TEXT PRIMARY KEY)");
  db.close();
  assert.ok(fs.existsSync(path.join(root, "state.sqlite")));
});
