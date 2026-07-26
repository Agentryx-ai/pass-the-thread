import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readClaudeJsonl } from "../src/claude-source.ts";
import { claudeTranscriptToIr } from "../src/claude-to-ir.ts";
import {
  codexRolloutToBridgeBundle,
  codexRolloutWithGoalToBridgeBundle,
} from "../src/codex-to-ir.ts";
import {
  createCanonicalGoalSnapshot,
  parseGoalMigrationMode,
  planGoalMigration,
  readCodexGoalSnapshot,
  validateCanonicalGoalSnapshot,
  validateGoalMigrationDecision,
} from "../src/goal.ts";
import { readBridgeConversation, writeBridgeConversation } from "../src/bridge-store.ts";
import { buildForwardMatrixPlan } from "../src/matrix-cli.ts";
import { buildImportPlan } from "../src/import-plan.ts";
import type { CodexSession } from "../src/types.ts";

const json = (value: unknown): string => JSON.stringify(value);
const sha256File = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function writeClaude(records: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-claude-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, `${records.map(json).join("\n")}\n`, "utf8");
  return file;
}

function goalAttachment(
  condition: string,
  state: { met?: boolean; failed?: boolean } = {},
): unknown {
  return {
    type: "attachment",
    sessionId: "claude-goal",
    attachment: {
      type: "goal_status",
      met: state.met ?? false,
      failed: state.failed ?? false,
      sentinel: true,
      condition,
    },
  };
}

function createGoalDb(codexHome: string, row?: {
  threadId?: string;
  goalId?: string;
  objective?: string;
  status?: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
}): string {
  fs.mkdirSync(codexHome, { recursive: true });
  const dbPath = path.join(codexHome, "goals_1.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    if (row) {
      db.prepare(`INSERT INTO thread_goals (
        thread_id, goal_id, objective, status, token_budget, tokens_used,
        time_used_seconds, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.threadId ?? "codex-goal",
        row.goalId ?? "goal-1",
        row.objective ?? "ship safely",
        row.status ?? "active",
        row.tokenBudget ?? null,
        row.tokensUsed ?? 12,
        row.timeUsedSeconds ?? 34,
        row.createdAtMs ?? 1000,
        row.updatedAtMs ?? 2000,
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function codexSession(rolloutPath: string): CodexSession {
  return {
    sessionId: "codex-goal",
    rolloutPath,
    cwd: "C:\\repo",
    cwdOriginal: "C:\\repo",
    meta: {},
    firstTsMs: null,
    lastTsMs: null,
    items: [],
    model: null,
    messageCount: 0,
    title: "Goal source",
    source: "vscode",
    isChild: false,
    userMessageCount: 0,
  };
}

test("Goal migration mode defaults to migrate and only accepts explicit modes", () => {
  assert.equal(parseGoalMigrationMode(), "migrate");
  assert.equal(parseGoalMigrationMode(""), "migrate");
  assert.equal(parseGoalMigrationMode("migrate"), "migrate");
  assert.equal(parseGoalMigrationMode("skip"), "skip");
  assert.throws(() => parseGoalMigrationMode("off"), /expected migrate or skip/);
});

function canonicalGoal(status: "active" | "complete", marker: string = status) {
  return createCanonicalGoalSnapshot({
    authority: "native-transcript", provider: "claude", sourceThreadId: "claude-goal",
    sourceGoalId: null, objective: `Goal ${marker}`, status, tokenBudget: null,
    tokensUsed: null, timeUsedSeconds: null, createdAtMs: null, updatedAtMs: null,
    locator: { sourcePath: "C:/session.jsonl", recordIndex: 0, table: null, key: "claude-goal" },
    sourceMaterial: { marker, status },
  });
}

test("Goal migration decisions are deterministic and never bind an unimplemented target", () => {
  const active = canonicalGoal("active");
  const migrate = planGoalMigration(active);
  const skip = planGoalMigration(active, "skip");
  assert.deepEqual(migrate, {
    mode: "migrate", sourceGoalSha256: active.sourceSha256, eligibility: "eligible",
    sourceStatus: "active", status: "pending_target_implementation",
    targetCapabilityId: null, targetGoalId: null,
  });
  assert.equal(skip.status, "skipped_by_policy");
  assert.equal(planGoalMigration(canonicalGoal("complete")).status, "historical_only");
  assert.equal(planGoalMigration(null).status, "no_source_goal");
  assert.doesNotThrow(() => validateGoalMigrationDecision(skip));
  assert.throws(() => validateGoalMigrationDecision({ ...skip, targetGoalId: "implicit" }), /not implemented/);
});

test("Goal mode, source hash, and status change the source inventory digest", () => {
  const build = (goalDecision: ReturnType<typeof planGoalMigration>) => buildImportPlan([{
    sessionId: "goal-digest", cwd: "C:/repo", sourceSha256: "transcript-stable", goalDecision,
  }]);
  const active = canonicalGoal("active", "a");
  const baseline = build(planGoalMigration(active));
  assert.notEqual(build(planGoalMigration(active, "skip")).digest, baseline.digest);
  assert.notEqual(build(planGoalMigration(canonicalGoal("active", "b"))).digest, baseline.digest);
  assert.notEqual(build(planGoalMigration(canonicalGoal("complete", "terminal"))).digest, baseline.digest);
  assert.equal(baseline.plan.sessions[0]?.sourceSha256, "transcript-stable");
});

test("Claude goal_status attachments preserve history and reduce last status as authoritative", () => {
  const file = writeClaude([
    goalAttachment("first goal"),
    { type: "user", sessionId: "claude-goal", message: { role: "user", content: "continue" } },
    goalAttachment("replacement goal", { met: true }),
  ]);
  const bundle = claudeTranscriptToIr(readClaudeJsonl(file));
  const history = bundle.conversation.events.filter((event) => event.kind === "goal_snapshot");

  assert.equal(history.length, 2);
  assert.deepEqual(history.map((event) => event.kind === "goal_snapshot" ? event.goal : null), [
    "first goal",
    "replacement goal",
  ]);
  assert.ok(history.every((event) => event.safety.activateGoal === false));
  assert.equal(bundle.conversation.goalState?.objective, "replacement goal");
  assert.equal(bundle.conversation.goalState?.status, "complete");
  assert.equal(bundle.conversation.goalState?.migrationEligible, false);
  assert.equal(bundle.conversation.goalState?.authority, "native-transcript");
  assert.equal(bundle.conversation.goalState?.locator.recordIndex, 2);
});

test("Claude active and failed goal_status states remain distinguishable", () => {
  const active = claudeTranscriptToIr(readClaudeJsonl(writeClaude([goalAttachment("active goal")])));
  const failed = claudeTranscriptToIr(readClaudeJsonl(writeClaude([
    goalAttachment("failed goal", { failed: true }),
  ])));
  assert.equal(active.conversation.goalState?.status, "active");
  assert.equal(active.conversation.goalState?.migrationEligible, true);
  assert.equal(failed.conversation.goalState?.status, "failed");
  assert.equal(failed.conversation.goalState?.migrationEligible, false);
});

test("Claude Goal authority rejects malformed terminal flags and mixed session identities", () => {
  assert.throws(
    () => claudeTranscriptToIr(readClaudeJsonl(writeClaude([{
      type: "attachment", sessionId: "claude-goal",
      attachment: { type: "goal_status", met: "true", condition: "bad" },
    }]))),
    /met must be a boolean/,
  );
  assert.throws(
    () => claudeTranscriptToIr(readClaudeJsonl(writeClaude([goalAttachment("bad", {
      met: true, failed: true,
    })]))),
    /cannot both be true/,
  );
  assert.throws(
    () => claudeTranscriptToIr(readClaudeJsonl(writeClaude([
      goalAttachment("first"),
      { type: "attachment", sessionId: "other-session", attachment: {
        type: "goal_status", met: false, condition: "contamination",
      } },
    ]))),
    /exactly one session identity/,
  );
});

test("Claude Goal provenance uses the exact selected record bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-exact-"));
  const compact = path.join(dir, "compact.jsonl");
  const spaced = path.join(dir, "spaced.jsonl");
  const compactRecord = '{"type":"attachment","sessionId":"claude-goal","attachment":{"type":"goal_status","met":false,"condition":"same"}}';
  const spacedRecord = '{ "type": "attachment", "sessionId": "claude-goal", "attachment": {"type":"goal_status","met":false,"condition":"same"} }';
  fs.writeFileSync(compact, `${compactRecord}\n`, "utf8");
  fs.writeFileSync(spaced, `${spacedRecord}\r\n`, "utf8");
  const compactSource = readClaudeJsonl(compact);
  const spacedSource = readClaudeJsonl(spaced);
  const compactGoal = claudeTranscriptToIr(compactSource).conversation.goalState;
  const spacedGoal = claudeTranscriptToIr(spacedSource).conversation.goalState;

  assert.equal(compactGoal?.sourceSha256, compactSource.records[0]?.contentSha256);
  assert.equal(spacedGoal?.sourceSha256, spacedSource.records[0]?.contentSha256);
  assert.notEqual(compactGoal?.sourceSha256, spacedGoal?.sourceSha256);
});

test("heuristic Goal set text stays historical and never becomes authoritative", () => {
  const file = writeClaude([{
    type: "user",
    sessionId: "claude-goal",
    message: { role: "user", content: "<local-command-stdout>Goal set: not canonical</local-command-stdout>" },
  }]);
  const bundle = claudeTranscriptToIr(readClaudeJsonl(file));
  assert.equal(bundle.conversation.goalState, undefined);
  const event = bundle.conversation.events[0];
  assert.equal(event.kind, "goal_snapshot");
  assert.equal(event.kind === "goal_snapshot" ? event.goal : null, "not canonical");
  assert.equal(event.safety.activateGoal, false);
});

test("canonical Goal hashes are deterministic and reject malformed values", () => {
  const input = {
    authority: "native-store" as const,
    provider: "codex",
    sourceThreadId: "thread",
    sourceGoalId: "goal",
    objective: "objective",
    status: "active" as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
    locator: { sourcePath: "C:/goals.sqlite", recordIndex: null, table: "thread_goals", key: "thread" },
    sourceMaterial: { b: 2, a: 1 },
  };
  assert.deepEqual(createCanonicalGoalSnapshot(input), createCanonicalGoalSnapshot({
    ...input,
    sourceMaterial: { a: 1, b: 2 },
  }));
  assert.throws(() => createCanonicalGoalSnapshot({ ...input, objective: "" }), /objective/);
  assert.throws(() => createCanonicalGoalSnapshot({ ...input, tokensUsed: 1.5 }), /tokensUsed/);
  const missing = { ...createCanonicalGoalSnapshot(input) } as Record<string, unknown>;
  delete missing.tokensUsed;
  assert.throws(() => validateCanonicalGoalSnapshot(missing), /missing tokensUsed/);
  const missingLocator = structuredClone(createCanonicalGoalSnapshot(input)) as unknown as Record<string, unknown>;
  delete (missingLocator.locator as Record<string, unknown>).table;
  assert.throws(() => validateCanonicalGoalSnapshot(missingLocator), /missing table/);
  for (const field of ["tokenBudget", "sourceGoalId"] as const) {
    const invalid = structuredClone(createCanonicalGoalSnapshot(input)) as unknown as Record<string, unknown>;
    invalid[field] = undefined;
    assert.throws(() => validateCanonicalGoalSnapshot(invalid), new RegExp(field));
  }
  const invalidLocator = structuredClone(createCanonicalGoalSnapshot(input)) as unknown as Record<string, unknown>;
  (invalidLocator.locator as Record<string, unknown>).table = undefined;
  assert.throws(() => validateCanonicalGoalSnapshot(invalidLocator), /locator\.table/);
  assert.throws(
    () => createCanonicalGoalSnapshot({ ...input, tokenBudget: undefined as unknown as null }),
    /tokenBudget/,
  );
});

test("Codex Goal store reads one valid row without modifying the database", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "goal-codex-"));
  const dbPath = createGoalDb(home, { tokenBudget: 500, status: "blocked" });
  const before = sha256File(dbPath);
  const snapshot = readCodexGoalSnapshot(home, "codex-goal");
  const after = sha256File(dbPath);

  assert.equal(after, before);
  assert.equal(snapshot?.sourceGoalId, "goal-1");
  assert.equal(snapshot?.objective, "ship safely");
  assert.equal(snapshot?.status, "blocked");
  assert.equal(snapshot?.migrationEligible, false);
  assert.equal(snapshot?.tokenBudget, 500);
  assert.equal(snapshot?.tokensUsed, 12);
  assert.equal(snapshot?.timeUsedSeconds, 34);
  assert.equal(snapshot?.authority, "native-store");
  assert.equal(snapshot?.locator.sourcePath, dbPath);
});

test("Codex Goal store preserves every observed native lifecycle status", () => {
  const statuses = [
    "active",
    "paused",
    "blocked",
    "usage_limited",
    "budget_limited",
    "complete",
  ] as const;

  for (const status of statuses) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `goal-status-${status}-`));
    createGoalDb(home, { status });
    const snapshot = readCodexGoalSnapshot(home, "codex-goal");
    assert.equal(snapshot?.status, status);
    assert.equal(snapshot?.migrationEligible, status === "active");
  }
});

test("Codex Goal store treats absent database, table, and row as no Goal", () => {
  const absent = fs.mkdtempSync(path.join(os.tmpdir(), "goal-absent-"));
  assert.equal(readCodexGoalSnapshot(absent, "missing"), null);

  const noTable = fs.mkdtempSync(path.join(os.tmpdir(), "goal-no-table-"));
  const empty = new DatabaseSync(path.join(noTable, "goals_1.sqlite"));
  empty.close();
  assert.equal(readCodexGoalSnapshot(noTable, "missing"), null);

  const noRow = fs.mkdtempSync(path.join(os.tmpdir(), "goal-no-row-"));
  createGoalDb(noRow);
  assert.equal(readCodexGoalSnapshot(noRow, "missing"), null);
});

test("Codex Goal store fails explicitly for an invalid authoritative row", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "goal-corrupt-row-"));
  createGoalDb(home, { status: "future-status" });
  assert.throws(() => readCodexGoalSnapshot(home, "codex-goal"), /Invalid Codex Goal status/);

  const failedHome = fs.mkdtempSync(path.join(os.tmpdir(), "goal-codex-failed-"));
  createGoalDb(failedHome, { status: "failed" });
  assert.throws(() => readCodexGoalSnapshot(failedHome, "codex-goal"), /Invalid Codex Goal status/);
});

test("Codex Goal lookup uses the authoritative Desktop thread id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-thread-id-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, `${json({ type: "session_meta", payload: { id: "reused-meta" } })}\n`, "utf8");
  const codexHome = path.join(root, ".codex");
  createGoalDb(codexHome, { threadId: "desktop-thread", objective: "right Goal" });
  const session = { ...codexSession(rollout), sessionId: "rollout-revision", desktopThreadId: "desktop-thread" };
  const bundle = codexRolloutWithGoalToBridgeBundle(session, codexHome);

  assert.equal(bundle.conversation.id, "rollout-revision");
  assert.equal(bundle.conversation.sourceThreadId, "desktop-thread");
  assert.equal(bundle.conversation.goalState?.sourceThreadId, "desktop-thread");
  assert.equal(bundle.conversation.goalState?.objective, "right Goal");
});

test("forward production planning captures the authoritative Codex Goal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-forward-plan-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, `${json({ type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_text", text: "hello" }],
  } })}\n`, "utf8");
  const codexHome = path.join(root, ".codex");
  createGoalDb(codexHome, { objective: "planned Goal" });
  const built = buildForwardMatrixPlan([codexSession(rollout)], {
    codexHome,
    claudeHome: path.join(root, ".claude"),
    bridgeRoot: path.join(root, "bridge"),
  });
  assert.equal(built.bundles[0]?.conversation.goalState?.objective, "planned Goal");
  assert.equal(built.file.goalMode, "migrate");
  assert.equal(built.file.plan.sessions[0]?.goalDecision.status, "pending_target_implementation");
  assert.equal(built.file.plan.sessions[0]?.goalDecision.sourceGoalSha256,
    built.bundles[0]?.conversation.goalState?.sourceSha256);
  assert.ok(built.file.plan.losses.byKind.some((loss) => loss.kind === "goal_activation_target_unimplemented"));

  const skipped = buildForwardMatrixPlan([codexSession(rollout)], {
    codexHome, claudeHome: path.join(root, ".claude"), bridgeRoot: path.join(root, "bridge"),
    goalMode: "skip",
  });
  assert.equal(skipped.file.plan.sessions[0]?.goalDecision.status, "skipped_by_policy");
  assert.equal(skipped.bundles[0]?.conversation.goalState?.objective, "planned Goal");
  assert.ok(skipped.bundles[0]?.conversation.events.every((event) => !event.safety.activateGoal));
});

test("a forward Goal-only change updates plan digests but not conversation target identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-forward-digest-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, `${json({ type: "session_meta", payload: { id: "codex-goal" } })}\n`, "utf8");
  const codexHome = path.join(root, ".codex");
  const dbPath = createGoalDb(codexHome, { objective: "first" });
  const options = { codexHome, claudeHome: path.join(root, ".claude"), bridgeRoot: path.join(root, "bridge") };
  const first = buildForwardMatrixPlan([codexSession(rollout)], options);
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE thread_goals SET objective = ?, updated_at_ms = ? WHERE thread_id = ?")
    .run("second", 3000, "codex-goal");
  db.close();
  const second = buildForwardMatrixPlan([codexSession(rollout)], options);
  assert.notEqual(second.file.digest, first.file.digest);
  assert.notEqual(second.sourceDigest, first.sourceDigest);
  assert.notEqual(second.file.plan.sessions[0]?.goalDecision.sourceGoalSha256,
    first.file.plan.sessions[0]?.goalDecision.sourceGoalSha256);
  assert.equal(second.file.plan.sessions[0]?.sourceSha256, first.file.plan.sessions[0]?.sourceSha256);
  assert.equal(second.file.target.sessions[0]?.targetPath, first.file.target.sessions[0]?.targetPath);
});

test("Goal changes create a new bridge revision even when rollout bytes do not change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-revision-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, `${json({ type: "session_meta", payload: { id: "codex-goal" } })}\n`, "utf8");
  const codexHome = path.join(root, ".codex");
  const dbPath = createGoalDb(codexHome, { objective: "first" });
  const session = codexSession(rollout);
  const bridgeRoot = path.join(root, "bridge");
  const sourceBytes = fs.readFileSync(rollout);

  const firstBundle = codexRolloutWithGoalToBridgeBundle(session, codexHome);
  const first = writeBridgeConversation(bridgeRoot, firstBundle);
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE thread_goals SET objective = ?, updated_at_ms = ? WHERE thread_id = ?")
    .run("second", 3000, session.sessionId);
  db.close();
  const secondBundle = codexRolloutWithGoalToBridgeBundle(session, codexHome);
  const second = writeBridgeConversation(bridgeRoot, secondBundle);

  assert.notEqual(first.operation.conversationSha256, second.operation.conversationSha256);
  assert.equal(firstBundle.conversation.sourceContentSha256, secondBundle.conversation.sourceContentSha256);
  assert.deepEqual(fs.readFileSync(rollout), sourceBytes);
  assert.equal(readBridgeConversation(bridgeRoot, session.sessionId).conversation.goalState?.objective, "second");
});

test("Codex rollout builder accepts an explicit authoritative Goal without activating it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-explicit-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, `${json({ type: "event_msg", payload: {
    type: "thread_goal_updated",
    objective: "historical only",
  } })}\n`, "utf8");
  const goal = createCanonicalGoalSnapshot({
    authority: "native-store",
    provider: "codex",
    sourceThreadId: "codex-goal",
    sourceGoalId: "goal-1",
    objective: "authoritative",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
    locator: { sourcePath: "C:/goals.sqlite", recordIndex: null, table: "thread_goals", key: "codex-goal" },
    sourceMaterial: { objective: "authoritative" },
  });
  const bundle = codexRolloutToBridgeBundle(codexSession(rollout), goal);
  assert.equal(bundle.conversation.goalState?.objective, "authoritative");
  const historical = bundle.conversation.events.find((event) => event.kind === "goal_snapshot");
  assert.equal(historical?.safety.activateGoal, false);

  assert.throws(
    () => codexRolloutToBridgeBundle(codexSession(rollout), { ...goal, provider: "claude" }),
    /provider mismatch/,
  );
  assert.throws(
    () => codexRolloutToBridgeBundle(codexSession(rollout), { ...goal, authority: "native-transcript" }),
    /authority mismatch/,
  );
  assert.throws(
    () => codexRolloutToBridgeBundle(codexSession(rollout), { ...goal, sourceThreadId: "other" }),
    /thread id mismatch/,
  );
});
