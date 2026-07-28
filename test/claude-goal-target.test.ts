import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import {
  activeClaudeGoalFromRecords,
  applyClaudeGoalTarget,
  claudeGoalHistoryIdentity,
  CLAUDE_GOAL_MAX_CONDITION_CHARS,
  CLAUDE_GOAL_TARGET_CAPABILITY_ID,
} from "../src/claude-goal-target.ts";
import { createCanonicalGoalSnapshot } from "../src/goal.ts";
import { mapSessionToClaudeLines } from "../src/map.ts";
import type { ClaudeTranscriptRecord, CodexSession } from "../src/types.ts";
import { validateTranscript } from "../src/validate.ts";
import { legacyGoalMigrationMode } from "../src/cli.ts";
import { fixTranscriptFile } from "../src/fix.ts";
import { applyBudget, repairTranscript } from "../src/repair.ts";

const SID = "11111111-2222-4333-8444-555555555555";

test("legacy CLI Goal mode defaults to migrate and rejects alias conflicts", () => {
  assert.equal(legacyGoalMigrationMode(undefined, false), "migrate");
  assert.equal(legacyGoalMigrationMode("skip", false), "skip");
  assert.equal(legacyGoalMigrationMode(undefined, true), "skip");
  assert.equal(legacyGoalMigrationMode("skip", true), "skip");
  assert.throws(() => legacyGoalMigrationMode("migrate", true), /contradicts/);
});

test("Goal history identity reflects effective controls and preserves no-Goal legacy dedup", () => {
  assert.deepEqual(claudeGoalHistoryIdentity(null, "migrate"), {
    mode: "skip",
    sourceGoalSha256: null,
    targetCapabilityId: null,
    targetFingerprint: null,
  });
  const terminal = goal("complete");
  assert.deepEqual(
    claudeGoalHistoryIdentity(terminal, "migrate"),
    claudeGoalHistoryIdentity(terminal, "skip"),
  );
  const active = claudeGoalHistoryIdentity(goal(), "migrate");
  assert.equal(active.mode, "migrate");
  assert.equal(active.targetCapabilityId, CLAUDE_GOAL_TARGET_CAPABILITY_ID);
});

function session(root: string): CodexSession {
  const rolloutPath = path.join(root, `rollout-${SID}.jsonl`);
  fs.writeFileSync(rolloutPath, [
    { timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id: SID, cwd: "C:\\repo", git: { branch: "main" } } },
    { timestamp: "2026-07-25T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    { timestamp: "2026-07-25T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  return {
    sessionId: SID, desktopThreadId: SID, rolloutPath, cwd: "C:\\repo", cwdOriginal: "C:\\repo",
    meta: { git: { branch: "main" } }, firstTsMs: Date.parse("2026-07-25T10:00:00Z"),
    lastTsMs: Date.parse("2026-07-25T10:00:02Z"), items: [
      { tsMs: Date.parse("2026-07-25T10:00:01Z"), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { tsMs: Date.parse("2026-07-25T10:00:02Z"), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] } },
    ], model: null, messageCount: 2, title: "hello", source: "vscode", isChild: false, userMessageCount: 1,
  };
}

function goal(status: "active" | "complete" = "active", objective = "ship safely") {
  return createCanonicalGoalSnapshot({
    authority: "native-store", provider: "codex", sourceThreadId: SID, sourceGoalId: "goal-1",
    objective, status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
    createdAtMs: 1, updatedAtMs: 2,
    locator: { sourcePath: "C:/goals_1.sqlite", recordIndex: null, table: "thread_goals", key: SID },
    sourceMaterial: { objective, status },
  });
}

test("active migrate writes linked historical, directive, and native Goal records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-goal-target-"));
  const source = session(root);
  const base = mapSessionToClaudeLines(source);
  const records = applyClaudeGoalTarget(source, base, goal(), "migrate");
  assert.equal(records.length, base.length + 3);
  const attachment = records.at(-3)!;
  const historical = records.at(-2)!;
  const directive = records.at(-1)!;
  assert.equal(historical.type, "user");
  assert.equal(directive.type, "user");
  assert.equal(directive.type === "user" ? directive.isMeta : false, true);
  assert.match(directive.type === "user" ? String(directive.message.content) : "", /session-scoped Stop hook/);
  assert.equal(attachment.type, "attachment");
  if (attachment.type !== "attachment") assert.fail("missing attachment");
  assert.deepEqual(attachment.attachment, { type: "goal_status", met: false, sentinel: true, condition: "ship safely" });
  assert.equal(attachment.entrypoint, "claude-desktop");
  assert.equal(attachment.sessionId, SID);
  assert.equal(attachment.cwd, source.cwd);
  assert.equal(historical.parentUuid, attachment.uuid);
  assert.equal(directive.parentUuid, historical.uuid);
  assert.equal(activeClaudeGoalFromRecords(records), "ship safely");
  assert.deepEqual(validateTranscript(records), []);
  assert.equal(CLAUDE_GOAL_TARGET_CAPABILITY_ID, "claude.goal-transcript/v1");
});

test("skip and terminal Goals stay visible but write zero live controls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-goal-skip-"));
  const source = session(root);
  for (const records of [
    applyClaudeGoalTarget(source, mapSessionToClaudeLines(source), goal(), "skip"),
    applyClaudeGoalTarget(source, mapSessionToClaudeLines(source), goal("complete"), "migrate"),
  ]) {
    assert.equal(records.filter((record) => record.type === "attachment").length, 0);
    assert.match(JSON.stringify(records.at(-1)), /Historical source Goal/);
    assert.equal(activeClaudeGoalFromRecords(records), null);
    assert.deepEqual(validateTranscript(records), []);
  }
  const heuristic = applyClaudeGoalTarget(source, mapSessionToClaudeLines(source), null, "migrate");
  assert.equal(heuristic.some((record) => record.type === "attachment"), false);
});

test("Claude Goal condition length fails closed without truncation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-goal-length-"));
  const source = session(root);
  const over = "x".repeat(CLAUDE_GOAL_MAX_CONDITION_CHARS + 1);
  assert.throws(() => applyClaudeGoalTarget(source, [], goal("active", over), "migrate"), /maximum is 4000/);
  assert.doesNotThrow(() => applyClaudeGoalTarget(source, [], goal("active", over), "skip"));
});

test("final transcript budgeting preserves Goal controls or fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-goal-budget-"));
  const source = session(root);
  source.items = Array.from({ length: 30 }, (_, index) => ({
    tsMs: index + 1,
    payload: {
      type: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text: `${index}:`.padEnd(120, "x") }],
    },
  }));
  const maxChars = 5000;
  const base = mapSessionToClaudeLines(source, { maxChars });
  const composed = applyClaudeGoalTarget(source, base, goal("active", "g".repeat(600)), "migrate");
  const sizeOf = (records: ClaudeTranscriptRecord[]) =>
    records.reduce((sum, record) => sum + JSON.stringify(record).length + 1, 0);
  assert.ok(sizeOf(composed) > maxChars);
  const budgeted = applyBudget(composed, maxChars, { preserveSuffix: 3 }).lines;
  assert.ok(sizeOf(budgeted) <= maxChars);
  assert.equal(budgeted.filter((record) => record.type === "attachment").length, 1);
  assert.deepEqual(validateTranscript(budgeted), []);

  const controlsOnly = applyClaudeGoalTarget(source, [], goal("active", "g".repeat(4000)), "migrate");
  assert.throws(
    () => applyBudget(controlsOnly, maxChars, { preserveSuffix: 3 }),
    /required transcript controls exceed/,
  );
});

test("Goal attachment validation rejects malformed identity and contradictory state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-goal-invalid-"));
  const source = session(root);
  const valid = applyClaudeGoalTarget(source, mapSessionToClaudeLines(source), goal(), "migrate");
  const index = valid.findIndex((record) => record.type === "attachment");
  assert.notEqual(index, -1);
  const malformed = structuredClone(valid) as Array<ClaudeTranscriptRecord & { attachment?: Record<string, unknown> }>;
  malformed[index]!.sessionId = "other";
  malformed[index]!.attachment!.failed = true;
  malformed[index]!.attachment!.condition = "";
  const kinds = validateTranscript(malformed).map((issue) => issue.kind);
  assert.ok(kinds.includes("session-identity"));
  assert.ok(kinds.includes("goal-attachment"));
});

test("Goal attachments do not interrupt pending tool-result adjacency", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-goal-tools-"));
  const source = session(root);
  source.items = [
    { tsMs: 1, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run" }] } },
    { tsMs: 2, payload: { type: "function_call", call_id: "c", name: "Read", arguments: "{}" } },
    { tsMs: 3, payload: { type: "function_call_output", call_id: "c", output: "done" } },
  ];
  const lines = mapSessionToClaudeLines(source);
  const attachment = applyClaudeGoalTarget(source, [], goal(), "migrate")
    .find((record) => record.type === "attachment")!;
  const records = [lines[0]!, lines[1]!, attachment, lines[2]!] as ClaudeTranscriptRecord[];
  for (let index = 0; index < records.length; index += 1) {
    records[index]!.parentUuid = index === 0 ? null : records[index - 1]!.uuid;
  }
  assert.deepEqual(validateTranscript(records), []);
  const repaired = repairTranscript(records);
  assert.deepEqual(validateTranscript(repaired), []);
  assert.equal(repaired.filter((record) => record.type === "attachment").length, 1);
  const results = repaired.flatMap((record) => {
    if (record.type === "attachment" || typeof record.message.content === "string") return [];
    return record.message.content.filter((block) => block.type === "tool_result");
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.tool_use_id, "c");
  assert.equal(results[0]!.content, "done");
});

test("transcript replay repair preserves and deduplicates the live Goal attachment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-goal-fix-"));
  const source = session(root);
  const once = applyClaudeGoalTarget(source, mapSessionToClaudeLines(source), goal(), "migrate");
  const replay = once.map((record) => ({ ...structuredClone(record), uuid: randomUUID() }));
  const doubled = [...once, ...replay];
  for (let index = 0; index < doubled.length; index += 1) {
    doubled[index]!.parentUuid = index === 0 ? null : doubled[index - 1]!.uuid;
  }
  const target = path.join(root, "target.jsonl");
  fs.writeFileSync(target, doubled.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const fixed = fixTranscriptFile(target);
  assert.equal(fixed?.changed, true);
  const records = fs.readFileSync(target, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.filter((record) => record.type === "attachment").length, 1);
  assert.equal(activeClaudeGoalFromRecords(records), "ship safely");
  assert.deepEqual(validateTranscript(records), []);
});

test("legacy CLI dry-run reports Goal activation and mutates no Claude data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-goal-cli-"));
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  const sourceDir = path.join(codexHome, "sessions", "2026", "07", "25");
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = session(root);
  fs.copyFileSync(source.rolloutPath, path.join(sourceDir, `rollout-2026-07-25T10-00-00-${SID}.jsonl`));
  const db = new DatabaseSync(path.join(codexHome, "goals_1.sqlite"));
  db.exec("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL, token_budget INTEGER, tokens_used INTEGER NOT NULL, time_used_seconds INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)");
  db.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(SID, "goal-1", "ship safely", "active", null, 0, 0, 1, 2);
  db.close();
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types", "--experimental-sqlite", "src/cli.ts", "import",
    "--codex-home", codexHome, "--claude-home", claudeHome, "--id", SID,
    "--dry-run", "--no-register",
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Goal mode: migrate/);
  assert.match(result.stdout, /Goal: activate/);
  assert.equal(fs.existsSync(claudeHome), false);
});
