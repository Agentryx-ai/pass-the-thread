import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyForwardSessions,
  deterministicWrapperPath,
  forwardSessionApplyPlan,
  loadForwardApplyJournal,
  renderForwardClaudeTranscript,
  rollbackForwardSessions,
} from "../src/claude-forward-target.ts";
import { codexRolloutToBridgeBundle } from "../src/codex-to-ir.ts";
import { createCanonicalGoalSnapshot } from "../src/goal.ts";
import { sha256File } from "../src/claude-target.ts";
import type { CodexSession } from "../src/types.ts";

function fixture(root: string): { session: CodexSession; exact: string } {
  const rolloutPath = path.join(root, "source.jsonl");
  const records = [
    { timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id: "11111111-2222-4333-8444-555555555555", cwd: path.join(root, "repo") } },
    { timestamp: "2026-07-25T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    { timestamp: "2026-07-25T10:00:02.000Z", type: "event_msg", payload: { type: "task_complete", message: "<task-notification><task-id>t1</task-id><status>failed</status><summary>review failed</summary></task-notification>" } },
    { timestamp: "2026-07-25T10:00:03.000Z", type: "world_state", payload: { secretControl: "must-not-render" } },
    { timestamp: "2026-07-25T10:00:04.000Z", type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" } },
    { timestamp: "2026-07-25T10:00:05.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "done" } },
  ];
  const exact = records.map((record) => JSON.stringify(record)).join("\r\n") + "\r\n";
  fs.writeFileSync(rolloutPath, exact, "utf8");
  const session: CodexSession = {
    sessionId: "11111111-2222-4333-8444-555555555555", rolloutPath,
    cwd: path.join(root, "repo"), cwdOriginal: path.join(root, "repo"), meta: {},
    firstTsMs: Date.parse(records[0]!.timestamp), lastTsMs: Date.parse(records.at(-1)!.timestamp),
    items: [], model: "gpt-5", messageCount: 1, title: "Typed import", codexName: "Typed import",
    source: "vscode", isChild: false, userMessageCount: 1, isArchived: true,
  };
  return { session, exact };
}

function onlyOperationId(bridgeRoot: string): string {
  const files = fs.readdirSync(path.join(bridgeRoot, "forward-operations"));
  assert.equal(files.length, 1);
  return path.basename(files[0]!, ".json");
}

test("typed semantic renderer makes controls inert while preserving native tool adjacency", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-render-"));
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  bundle.conversation.goalState = createCanonicalGoalSnapshot({
    authority: "native-store", provider: "codex", sourceThreadId: session.sessionId,
    sourceGoalId: "g1", objective: "Finish safely", status: "active",
    tokenBudget: null, tokensUsed: null, timeUsedSeconds: null, createdAtMs: null, updatedAtMs: null,
    locator: { sourcePath: "goals.sqlite", recordIndex: null, table: "thread_goals", key: session.sessionId },
    sourceMaterial: { objective: "Finish safely", status: "active" },
  });
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const rendered = JSON.stringify(lines);
  assert.doesNotMatch(rendered, /<task-notification>/);
  assert.doesNotMatch(rendered, /must-not-render/);
  assert.match(rendered, /Historical task notification t1/);
  assert.match(rendered, /Historical source Goal/);
  const historicalGoal = lines.find((line) => line.type === "user" && JSON.stringify(line.message).includes("Historical source Goal"));
  assert.equal(historicalGoal?.type === "user" ? historicalGoal.isMeta : false, true);
  assert.doesNotMatch(rendered, /goal_status/);
  const toolLine = lines.findIndex((line) => line.type !== "attachment" && JSON.stringify(line.message).includes("tool_use"));
  assert.ok(toolLine >= 0);
  assert.match(JSON.stringify(lines[toolLine + 1]), /tool_result/);
});

test("semantic renderer preserves image-only user turns and keeps reasoning inert", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-media-"));
  const id = "22222222-3333-4444-8555-666666666666";
  const rolloutPath = path.join(root, "media.jsonl");
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id, cwd: root } }),
    JSON.stringify({ timestamp: "2026-07-25T10:00:01.000Z", type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
    } }),
    JSON.stringify({ timestamp: "2026-07-25T10:00:02.000Z", type: "response_item", payload: {
      type: "reasoning", summary: [{ type: "summary_text", text: "private summary" }], content: null,
    } }),
  ].join("\n") + "\n");
  const session: CodexSession = {
    sessionId: id, rolloutPath, cwd: root, cwdOriginal: root, meta: {}, firstTsMs: 0, lastTsMs: 1,
    items: [], model: null, messageCount: 1, title: "media", source: "vscode", isChild: false, userMessageCount: 1,
  };
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const media = bundle.conversation.events.find((event) => event.kind === "media");
  assert.equal(media?.kind === "media" ? media.authoredByHuman : false, true);
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const imageLine = lines.find((line) => line.type === "user" && JSON.stringify(line.message).includes('"type":"image"'));
  assert.equal(imageLine?.type === "user" ? imageLine.isMeta : true, undefined);
  assert.equal(lines.some((line) => line.type === "assistant" && JSON.stringify(line.message).includes('"type":"thinking"')), false);
  const reasoning = lines.find((line) => line.type === "user" && JSON.stringify(line.message).includes("Historical Codex reasoning"));
  assert.equal(reasoning?.type === "user" ? reasoning.isMeta : false, true);
});

test("semantic renderer refuses malformed or non-data images instead of emitting invalid native blocks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-invalid-media-"));
  const id = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  const rolloutPath = path.join(root, "invalid-media.jsonl");
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id, cwd: root } }),
    JSON.stringify({ timestamp: "2026-07-25T10:00:01.000Z", type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,%%%" }],
    } }),
  ].join("\n") + "\n");
  const session: CodexSession = {
    sessionId: id, rolloutPath, cwd: root, cwdOriginal: root, meta: {}, firstTsMs: 0, lastTsMs: 1,
    items: [], model: null, messageCount: 1, title: "invalid media", source: "vscode", isChild: false, userMessageCount: 1,
  };
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  assert.equal(lines.some((line) => JSON.stringify(line).includes('"type":"image"')), false);
  assert.match(JSON.stringify(lines), /no safely renderable chat events/);
});

test("compacted replacement history is rendered after the active boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-compact-replacement-"));
  const id = "33333333-4444-4555-8666-777777777777";
  const rolloutPath = path.join(root, "compact.jsonl");
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id, cwd: root } }),
    JSON.stringify({ timestamp: "2026-07-25T10:00:01.000Z", type: "compacted", payload: { replacement_history: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "replacement survives" }] },
    ] } }),
  ].join("\n") + "\n");
  const session: CodexSession = {
    sessionId: id, rolloutPath, cwd: root, cwdOriginal: root, meta: {}, firstTsMs: 0, lastTsMs: 1,
    items: [], model: null, messageCount: 1, title: "compact", source: "vscode", isChild: false, userMessageCount: 1,
  };
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const boundary = lines.findIndex((line) => line.type === "system" && line.subtype === "compact_boundary");
  const replacement = lines.findIndex((line) => JSON.stringify(line).includes("replacement survives"));
  assert.ok(boundary >= 0);
  assert.ok(replacement > boundary);
});

test("verbatim renderer preserves exact canonical text as one inert payload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-verbatim-"));
  const { session, exact } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "verbatim", goalMode: "skip" });
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.equal(line.type, "user");
  assert.equal(line.type === "user" ? line.isMeta : false, true);
  assert.equal(line.type === "user" && Array.isArray(line.message.content) ? line.message.content[1]?.type === "text" ? line.message.content[1].text : null : null, exact);
});

test("renderer fails closed on oversized active context but honors the last compact boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-budget-"));
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const rolloutPath = path.join(root, "large.jsonl");
  const huge = "x".repeat(1_000_100);
  const records = [
    { timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id, cwd: path.join(root, "repo") } },
    { timestamp: "2026-07-25T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: huge }] } },
  ];
  const write = (value: unknown[]): void => fs.writeFileSync(rolloutPath, value.map((record) => JSON.stringify(record)).join("\n") + "\n");
  write(records);
  const session: CodexSession = {
    sessionId: id, rolloutPath, cwd: path.join(root, "repo"), cwdOriginal: path.join(root, "repo"), meta: {},
    firstTsMs: 0, lastTsMs: 1, items: [], model: null, messageCount: 1, title: "large",
    source: "vscode", isChild: false, userMessageCount: 1,
  };
  let bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  assert.throws(() => renderForwardClaudeTranscript(session, bundle, {
    renderMode: "semantic", goalMode: "skip",
  }), /active context.*maximum is 1000000/);

  write([...records,
    { timestamp: "2026-07-25T10:00:02.000Z", type: "compacted", payload: { replacement_history: [] } },
    { timestamp: "2026-07-25T10:00:03.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "resume here" }] } },
  ]);
  session.sourceContentSha256 = undefined;
  bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  assert.doesNotThrow(() => renderForwardClaudeTranscript(session, bundle, {
    renderMode: "semantic", goalMode: "skip",
  }));
});

test("forward transaction backs up before overwrite, resumes a crash window, and rolls back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-apply-"));
  const bridgeRoot = path.join(root, "bridge");
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const transcript = path.join(root, "claude", "projects", "p", `${session.sessionId}.jsonl`);
  const wrapper = deterministicWrapperPath(path.join(root, "workspace"), session.sessionId);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(transcript, "old transcript\n", "utf8");
  fs.writeFileSync(wrapper, "{\"old\":true}", "utf8");
  const oldTranscript = sha256File(transcript);
  const oldWrapper = sha256File(wrapper);
  const plan = forwardSessionApplyPlan(session, lines, transcript, wrapper);
  assert.throws(() => applyForwardSessions([plan], {
    bridgeRoot, claudeHome: path.join(root, "claude"), workspaceDir: path.join(root, "workspace"),
    planDigest: "a".repeat(64), allowOverwrite: false,
  }), /requires --allow-overwrite/);
  assert.equal(fs.existsSync(bridgeRoot), false);

  assert.throws(() => applyForwardSessions([plan], {
    bridgeRoot, claudeHome: path.join(root, "claude"), workspaceDir: path.join(root, "workspace"),
    planDigest: "a".repeat(64), allowOverwrite: true, failureAfterWrites: 1,
  }), /injected forward apply failure/);
  const operationDir = path.join(bridgeRoot, "forward-operations");
  const operationFile = fs.readdirSync(operationDir)[0]!;
  const operationId = path.basename(operationFile, ".json");
  assert.equal(loadForwardApplyJournal(bridgeRoot, operationId).state, "applying");
  assert.notEqual(sha256File(transcript), oldTranscript);
  assert.equal(sha256File(wrapper), oldWrapper);
  rollbackForwardSessions(bridgeRoot, operationId);
  assert.equal(sha256File(transcript), oldTranscript);
  assert.equal(sha256File(wrapper), oldWrapper);
});

test("rollback treats an unchanged existing asset as a no-op in a partially applied batch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-noop-batch-"));
  const bridgeRoot = path.join(root, "bridge");
  const claudeHome = path.join(root, "claude");
  const workspaceDir = path.join(root, "workspace");
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const transcript = path.join(claudeHome, "projects", "fixture", `${session.sessionId}.jsonl`);
  const wrapper = deterministicWrapperPath(workspaceDir, session.sessionId);
  const initial = forwardSessionApplyPlan(session, lines, transcript, wrapper);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(transcript, initial.transcript.afterContents);
  fs.writeFileSync(wrapper, "{\"old\":true}");
  const oldWrapper = sha256File(wrapper);
  const plan = forwardSessionApplyPlan(session, lines, transcript, wrapper);
  assert.equal(plan.transcript.beforeSha256, plan.transcript.afterSha256);
  assert.throws(() => applyForwardSessions([plan], {
    bridgeRoot, claudeHome, workspaceDir, planDigest: "3".repeat(64),
    allowOverwrite: true, failureAfterWrites: 1,
  }), /injected forward apply failure/);
  assert.equal(rollbackForwardSessions(bridgeRoot, onlyOperationId(bridgeRoot)).state, "rolled-back");
  assert.equal(sha256File(transcript), plan.transcript.afterSha256);
  assert.equal(sha256File(wrapper), oldWrapper);
});

test("forward transaction resumes after a write-before-journal crash and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-resume-"));
  const bridgeRoot = path.join(root, "bridge");
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const plan = forwardSessionApplyPlan(session, lines, path.join(root, "projects", "fixture", "target.jsonl"), null);
  assert.throws(() => applyForwardSessions([plan], {
    bridgeRoot, claudeHome: root, workspaceDir: null,
    planDigest: "b".repeat(64), allowOverwrite: false, failureAfterWrites: 1,
  }), /injected forward apply failure/);
  const completed = applyForwardSessions([plan], {
    bridgeRoot, claudeHome: root, workspaceDir: null,
    planDigest: "b".repeat(64), allowOverwrite: false,
  });
  assert.equal(completed.state, "committed");
  assert.equal(applyForwardSessions([plan], {
    bridgeRoot, claudeHome: root, workspaceDir: null,
    planDigest: "b".repeat(64), allowOverwrite: false,
  }).state, "committed");
});

test("journal and link publication flush writable destinations when directory fsync is unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-durable-publish-"));
  const bridgeRoot = path.join(root, "bridge");
  const claudeHome = path.join(root, "claude");
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const plan = forwardSessionApplyPlan(session, lines, path.join(claudeHome, "projects", "fixture", "target.jsonl"), null);
  const mutableFs = fs as unknown as {
    openSync: typeof fs.openSync;
    fsyncSync: typeof fs.fsyncSync;
  };
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  let writableReopens = 0;
  mutableFs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (flags === "r+") writableReopens += 1;
    return originalOpen(filePath, flags, mode);
  }) as typeof fs.openSync;
  mutableFs.fsyncSync = ((fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) {
      throw Object.assign(new Error("directory fsync unavailable"), { code: "EPERM" });
    }
    return originalFsync(fd);
  }) as typeof fs.fsyncSync;
  try {
    assert.equal(applyForwardSessions([plan], {
      bridgeRoot, claudeHome, workspaceDir: null, planDigest: "5".repeat(64), allowOverwrite: false,
    }).state, "committed");
  } finally {
    mutableFs.openSync = originalOpen;
    mutableFs.fsyncSync = originalFsync;
  }
  assert.ok(writableReopens >= 4, `expected journal/link destination flushes, got ${writableReopens}`);
});

test("a post-commit concurrent target change is preserved and journaled for reconciliation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-commit-race-"));
  const bridgeRoot = path.join(root, "bridge");
  const claudeHome = path.join(root, "claude");
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const target = path.join(claudeHome, "projects", "fixture", "target.jsonl");
  const plan = forwardSessionApplyPlan(session, lines, target, null);
  assert.throws(() => applyForwardSessions([plan], {
    bridgeRoot, claudeHome, workspaceDir: null, planDigest: "6".repeat(64), allowOverwrite: false,
    afterCommittedJournal: () => fs.writeFileSync(target, "concurrent post-commit bytes\n"),
  }), /committed but cleanup requires reconciliation/);
  const operationId = onlyOperationId(bridgeRoot);
  assert.equal(loadForwardApplyJournal(bridgeRoot, operationId).state, "reconciliation-required");
  assert.equal(fs.readFileSync(target, "utf8"), "concurrent post-commit bytes\n");
  assert.equal(rollbackForwardSessions(bridgeRoot, operationId).state, "reconciliation-required");
  assert.equal(fs.readFileSync(target, "utf8"), "concurrent post-commit bytes\n");
});

test("forward transaction reconciles a crash after checked move-aside but before publish", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-move-crash-"));
  const bridgeRoot = path.join(root, "bridge");
  const claudeHome = path.join(root, "claude");
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const target = path.join(claudeHome, "projects", "fixture", "target.jsonl");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "before\n");
  const plan = forwardSessionApplyPlan(session, lines, target, null);
  assert.throws(() => applyForwardSessions([plan], {
    bridgeRoot, claudeHome, workspaceDir: null, planDigest: "c".repeat(64),
    allowOverwrite: true, failureAfterMoves: 1,
  }), /injected forward move failure/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(path.dirname(target), `.${path.basename(target)}.pass-the-thread.swap`)), true);
  const completed = applyForwardSessions([plan], {
    bridgeRoot, claudeHome, workspaceDir: null, planDigest: "c".repeat(64), allowOverwrite: true,
  });
  assert.equal(completed.state, "committed");
  assert.equal(sha256File(target), plan.transcript.afterSha256);
});

test("a read-only existing target can recover after the checked move window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-readonly-"));
  const bridgeRoot = path.join(root, "bridge");
  const claudeHome = path.join(root, "claude");
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const target = path.join(claudeHome, "projects", "fixture", "target.jsonl");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "read only before\n");
  const before = sha256File(target);
  fs.chmodSync(target, 0o444);
  const plan = forwardSessionApplyPlan(session, lines, target, null);
  assert.throws(() => applyForwardSessions([plan], {
    bridgeRoot, claudeHome, workspaceDir: null, planDigest: "4".repeat(64),
    allowOverwrite: true, failureAfterMoves: 1,
  }), /injected forward move failure/);
  assert.equal(rollbackForwardSessions(bridgeRoot, onlyOperationId(bridgeRoot)).state, "rolled-back");
  assert.equal(sha256File(target), before);
  fs.chmodSync(target, 0o600);
});

test("rollback restores non-UTF8 bytes exactly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forward-binary-"));
  const bridgeRoot = path.join(root, "bridge");
  const claudeHome = path.join(root, "claude");
  const { session } = fixture(root);
  const bundle = codexRolloutToBridgeBundle(session);
  session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
  const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
  const target = path.join(claudeHome, "projects", "fixture", "target.jsonl");
  const before = Buffer.from([0xff, 0xfe, 0x00, 0x61, 0x80, 0x0a]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, before);
  const plan = forwardSessionApplyPlan(session, lines, target, null);
  assert.throws(() => applyForwardSessions([plan], {
    bridgeRoot, claudeHome, workspaceDir: null, planDigest: "d".repeat(64),
    allowOverwrite: true, failureAfterWrites: 1,
  }), /injected forward apply failure/);
  rollbackForwardSessions(bridgeRoot, onlyOperationId(bridgeRoot));
  assert.deepEqual(fs.readFileSync(target), before);
});

test("rollback resumes both restore cleanup crash windows", () => {
  for (const failure of ["afterRestoreLinks", "afterRestoreStageDeletes"] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `forward-restore-${failure}-`));
    const bridgeRoot = path.join(root, "bridge");
    const claudeHome = path.join(root, "claude");
    const { session } = fixture(root);
    const bundle = codexRolloutToBridgeBundle(session);
    session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
    const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
    const target = path.join(claudeHome, "projects", "fixture", "target.jsonl");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "before restore\n");
    const before = sha256File(target);
    const plan = forwardSessionApplyPlan(session, lines, target, null);
    assert.throws(() => applyForwardSessions([plan], {
      bridgeRoot, claudeHome, workspaceDir: null, planDigest: failure === "afterRestoreLinks" ? "e".repeat(64) : "f".repeat(64),
      allowOverwrite: true, failureAfterWrites: 1,
    }), /injected forward apply failure/);
    const operationId = onlyOperationId(bridgeRoot);
    assert.throws(() => rollbackForwardSessions(bridgeRoot, operationId, { [failure]: 1 }), /injected forward rollback/);
    assert.equal(sha256File(target), before);
    assert.equal(rollbackForwardSessions(bridgeRoot, operationId).state, "rolled-back");
    assert.equal(sha256File(target), before);
  }
});

test("created-target rollback resumes after move and preserves a concurrent replacement", () => {
  const setup = (suffix: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `forward-created-${suffix}-`));
    const bridgeRoot = path.join(root, "bridge");
    const claudeHome = path.join(root, "claude");
    const { session } = fixture(root);
    const bundle = codexRolloutToBridgeBundle(session);
    session.sourceContentSha256 = bundle.conversation.sourceContentSha256;
    const lines = renderForwardClaudeTranscript(session, bundle, { renderMode: "semantic", goalMode: "skip" });
    const target = path.join(claudeHome, "projects", "fixture", "target.jsonl");
    const plan = forwardSessionApplyPlan(session, lines, target, null);
    assert.throws(() => applyForwardSessions([plan], {
      bridgeRoot, claudeHome, workspaceDir: null, planDigest: suffix === "crash" ? "1".repeat(64) : "2".repeat(64),
      allowOverwrite: false, failureAfterWrites: 1,
    }), /injected forward apply failure/);
    return { bridgeRoot, target, operationId: onlyOperationId(bridgeRoot) };
  };

  const crash = setup("crash");
  assert.throws(() => rollbackForwardSessions(crash.bridgeRoot, crash.operationId, { afterRemovalMoves: 1 }), /removal failure/);
  assert.equal(fs.existsSync(crash.target), false);
  assert.equal(rollbackForwardSessions(crash.bridgeRoot, crash.operationId).state, "rolled-back");
  assert.equal(fs.existsSync(crash.target), false);

  const race = setup("race");
  assert.throws(() => rollbackForwardSessions(race.bridgeRoot, race.operationId, {
    beforeRemovalMove: () => fs.writeFileSync(race.target, "concurrent Claude bytes\n"),
  }), /target changed during rollback removal/);
  assert.equal(fs.readFileSync(race.target, "utf8"), "concurrent Claude bytes\n");
});
