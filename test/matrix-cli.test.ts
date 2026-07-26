import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  matrixPlanDigest,
  buildForwardMatrixPlan,
  forwardLossObservations,
  main,
  nativeToolUseIds,
  formatCliError,
  selectionFromPlan,
  selectionOptions,
  transcriptIdentityError,
  type MatrixPlanFile,
} from "../src/matrix-cli.ts";
import type { ImportPlan } from "../src/import-plan.ts";
import type { ClaudeDesktopSourceSession } from "../src/claude-desktop-source.ts";
import type { ClaudeSourceTranscript } from "../src/claude-source.ts";
import { HISTORICAL_SAFETY, type BridgeEvent } from "../src/ir.ts";
import type { CodexSession } from "../src/types.ts";
import { targetPathFor } from "../src/claude-target.ts";

test("matrix CLI leaves absent repeatable selectors unconstrained", () => {
  assert.deepEqual(selectionOptions(["scan", "--archive", "all", "--limit", "1"]), {
    archive: "all",
    projectScope: undefined,
    sessionIds: undefined,
    projects: undefined,
    fromMs: undefined,
    toMs: undefined,
    limit: 1,
  });
});

test("an empty normalized plan selector remains unconstrained during apply", () => {
  const plan = {
    version: 1,
    selection: {
      archive: "all", projectScope: "all", sessionIds: [], projects: [],
      fromMs: null, toMs: null, limit: null,
    },
    sessions: [],
    losses: {
      totalSessionCount: 0, lossySessionCount: 0, losslessSessionCount: 0,
      totalCount: 0, byKind: [], sessions: [],
    },
  } satisfies ImportPlan;
  assert.equal(selectionFromPlan(plan).sessionIds, undefined);
  assert.equal(selectionFromPlan(plan).projects, undefined);
});

test("the confirmed matrix digest binds render mode and target identity", () => {
  const base: Omit<Extract<MatrixPlanFile, { direction: "claude-to-codex" }>, "digest"> = {
    schema: "agentryx.import-plan/v2",
    direction: "claude-to-codex",
    renderMode: "semantic",
    plan: {
      version: 1,
      selection: { archive: "active", projectScope: "all", sessionIds: [], projects: [], fromMs: null, toMs: null, limit: null },
      sessions: [],
      losses: {
        totalSessionCount: 0, lossySessionCount: 0, losslessSessionCount: 0,
        totalCount: 0, byKind: [], sessions: [],
      },
    },
    target: {
      codexHome: "C:\\.codex",
      dbPath: "C:\\.codex\\state_5.sqlite",
      bridgeRoot: "C:\\bridge",
      evidence: { internalVersion: "26.721.41059", appAsarSha256: "a", codexExeSha256: "b" },
      sessions: [],
    },
  };
  const semantic = matrixPlanDigest(base);
  assert.notEqual(matrixPlanDigest({ ...base, renderMode: "verbatim" }), semantic);
  assert.notEqual(matrixPlanDigest({ ...base, target: { ...base.target, codexHome: "D:\\.codex" } }), semantic);
  assert.notEqual(matrixPlanDigest({
    ...base,
    target: { ...base.target, evidence: { ...base.target.evidence, appAsarSha256: "changed" } },
  }), semantic);
});

function codexSession(
  root: string,
  id: string,
  records: unknown[],
  overrides: Partial<CodexSession> = {},
): CodexSession {
  const rolloutPath = path.join(root, `${id}.jsonl`);
  fs.writeFileSync(rolloutPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return {
    sessionId: id,
    rolloutPath,
    cwd: path.join(root, "repo"),
    cwdOriginal: path.join(root, "repo"),
    meta: {},
    firstTsMs: Date.parse("2026-07-25T10:00:00.000Z"),
    lastTsMs: Date.parse("2026-07-25T10:10:00.000Z"),
    items: [],
    model: null,
    messageCount: 1,
    title: id,
    source: "vscode",
    isChild: false,
    projectName: "Fixture",
    hasProject: true,
    isArchived: false,
    userMessageCount: 1,
    ...overrides,
  };
}

test("forward semantic plan is exhaustive, deterministic, and read-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-forward-"));
  const claudeHome = path.join(root, "claude-home");
  const bridgeRoot = path.join(root, "bridge");
  const session = codexSession(root, "forward-rich", [
    { timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id: "forward-rich", cwd: path.join(root, "repo") } },
    { timestamp: "2026-07-25T10:00:00.500Z", type: "turn_context", payload: { approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } } },
    { timestamp: "2026-07-25T10:00:01.000Z", type: "event_msg", payload: { type: "thread_goal_updated", goal: "ship safely", status: "active" } },
    { timestamp: "2026-07-25T10:00:02.000Z", type: "event_msg", payload: { type: "task_complete", message: "<task-notification><task-id>t-1</task-id></task-notification>" } },
    { timestamp: "2026-07-25T10:00:03.000Z", type: "world_state", payload: { opaque: true } },
    { timestamp: "2026-07-25T10:00:04.000Z", type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "hello" },
      { type: "input_image", image_url: "data:image/png;base64,AA==" },
      { type: "input_audio", audio_url: "data:audio/wav;base64,AA==" },
      { type: "future", opaque: true },
    ] } },
    { timestamp: "2026-07-25T10:00:05.000Z", type: "response_item", payload: { type: "reasoning", summary: "why", content: "because" } },
    { timestamp: "2026-07-25T10:00:06.000Z", type: "response_item", payload: { type: "function_call", call_id: "c-1", name: "read", arguments: "{}" } },
    { timestamp: "2026-07-25T10:00:07.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c-1", output: "done" } },
    { timestamp: "2026-07-25T10:00:08.000Z", type: "compacted", payload: { replacement_history: [] } },
  ]);

  const first = buildForwardMatrixPlan([session], {
    claudeHome,
    bridgeRoot,
    selection: { archive: "all" },
    renderMode: "semantic",
  });
  const second = buildForwardMatrixPlan([session], {
    claudeHome,
    bridgeRoot,
    selection: { archive: "all" },
    renderMode: "semantic",
  });

  assert.deepEqual(second.file, first.file);
  assert.equal(first.file.direction, "codex-to-claude");
  assert.equal(first.file.target.renderPolicy.includeReasoning, true);
  assert.equal(first.file.target.sessions[0]?.targetPath, path.resolve(targetPathFor(claudeHome, session).targetPath));
  assert.equal(first.file.target.sessions[0]?.targetExists, false);
  assert.equal(fs.existsSync(claudeHome), false);
  assert.equal(fs.existsSync(bridgeRoot), false);
  assert.deepEqual(
    new Set(first.bundles[0]!.conversation.events.map((event) => event.sourceEnvelopeId)),
    new Set(first.bundles[0]!.conversation.recordEnvelopeIds),
  );
  assert.deepEqual(
    first.file.plan.losses.byKind.map((loss) => loss.kind),
    [
      "access_snapshot_not_rendered_or_applied",
      "event_msg_protocol_sidecar_only",
      "historical_goal_not_rendered_or_activated",
      "protocol_record_sidecar_only:session_meta",
      "task_notification_not_rendered",
      "turn_context_sidecar_only",
      "unknown_event_sidecar_only:unknown_content_block",
      "unsupported_media_not_rendered:audio",
      "world_state_sidecar_only",
    ],
  );
  const eventKinds = new Set(first.bundles[0]!.conversation.events.map((event) => event.kind));
  assert.ok(eventKinds.has("reasoning"));
  assert.ok(eventKinds.has("tool_use"));
  assert.ok(eventKinds.has("media"));

  const reverseLike = {
    schema: "agentryx.import-plan/v2" as const,
    direction: "claude-to-codex" as const,
    renderMode: first.file.renderMode,
    plan: first.file.plan,
    target: {
      codexHome: path.join(root, "codex"), dbPath: path.join(root, "state.sqlite"), bridgeRoot,
      evidence: { internalVersion: "26.721.41059", appAsarSha256: "a", codexExeSha256: "b" }, sessions: [],
    },
  };
  assert.notEqual(matrixPlanDigest(reverseLike), first.file.digest);
});

test("forward loss policy makes verbatim semantics inert and keeps supported events lossless", () => {
  const base = {
    id: "e", sourceEnvelopeId: "r", path: "$", timestamp: null, safety: HISTORICAL_SAFETY,
  };
  const events: BridgeEvent[] = [
    { ...base, id: "text", kind: "text", role: "user", text: "hi", authoredByHuman: true },
    { ...base, id: "reason", kind: "reasoning", summary: "s", content: "c" },
    { ...base, id: "image", kind: "media", mediaType: "image", source: "data:image/png;base64,AA==", metadata: {} },
    { ...base, id: "compact", kind: "compact_boundary", compactMetadata: {}, activeContextStartsAfter: true },
  ];
  assert.deepEqual(forwardLossObservations(events, "semantic"), []);
  assert.deepEqual(forwardLossObservations(events, "verbatim"), [{
    kind: "verbatim_semantics_intentionally_inert", count: 4,
    detail: "Canonical source text is preserved, but source-native semantics are not activated in Claude.",
  }]);
});

test("apply rejects a stored forward plan before requesting reverse-only evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-forward-apply-"));
  const session = codexSession(root, "read-only", [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
  ]);
  const built = buildForwardMatrixPlan([session], {
    claudeHome: path.join(root, "claude"),
    bridgeRoot: path.join(root, "bridge"),
  });
  const planPath = path.join(root, "forward-plan.json");
  fs.writeFileSync(planPath, JSON.stringify(built.file), "utf8");
  assert.throws(
    () => main(["apply", "--plan", planPath]),
    /codex-to-claude apply is read-only and is not implemented yet/,
  );
});

test("forward CLI plan includes protocol-only active and archived rollouts without target mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-forward-cli-"));
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  const bridgeRoot = path.join(root, "bridge");
  const sourceDir = path.join(codexHome, "sessions", "2026", "07", "25");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": {
      fixture: { id: "fixture", name: "FixtureProject", rootPaths: [path.join(root, "repo")] },
    },
    "project-order": ["fixture"],
  }));
  const sessionId = "11111111-2222-4333-8444-555555555555";
  fs.writeFileSync(path.join(sourceDir, `rollout-2026-07-25T10-00-00-${sessionId}.jsonl`), [
    "null",
    JSON.stringify({ timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id: sessionId, cwd: path.join(root, "repo"), source: "vscode" } }),
    JSON.stringify({ timestamp: "2026-07-25T10:00:01.000Z", type: "world_state", payload: { state: "active-only" } }),
  ].join("\n") + "\n", "utf8");
  const archivedDir = path.join(codexHome, "archived_sessions");
  fs.mkdirSync(archivedDir, { recursive: true });
  const archivedId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": {
      fixture: { id: "fixture", name: "FixtureProject", rootPaths: [path.join(root, "wrong-root")] },
    },
    "thread-project-assignments": {
      [sessionId]: { projectId: "fixture" },
      [archivedId]: { projectId: "fixture" },
    },
  }));
  fs.writeFileSync(path.join(archivedDir, `rollout-2026-07-24T10-00-00-${archivedId}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-24T10:00:00.000Z", type: "session_meta", payload: { id: archivedId, cwd: path.join(root, "repo"), source: "vscode" } }),
    JSON.stringify({ timestamp: "2026-07-24T10:00:01.000Z", type: "event_msg", payload: { type: "task_started" } }),
  ].join("\n") + "\n", "utf8");
  const out = path.join(root, "plan.json");

  main([
    "plan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", claudeHome, "--bridge-root", bridgeRoot, "--archive", "all",
    "--project", "FixtureProject", "--out", out,
  ]);

  const stored = JSON.parse(fs.readFileSync(out, "utf8")) as MatrixPlanFile;
  assert.equal(stored.direction, "codex-to-claude");
  assert.deepEqual(
    stored.plan.sessions.map((session) => session.sessionId).sort(),
    [archivedId, sessionId].sort(),
  );
  assert.equal(stored.plan.sessions.find((session) => session.sessionId === archivedId)?.archived, true);
  assert.ok(stored.plan.sessions.every((session) => session.projectName === "FixtureProject"));
  assert.equal(fs.existsSync(claudeHome), false);
  assert.equal(fs.existsSync(bridgeRoot), false);
});

test("forward selection supports exact target existence, filters, explicit limits, and no implicit 50 cap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-forward-select-"));
  const claudeHome = path.join(root, "claude");
  const bridgeRoot = path.join(root, "bridge");
  const sessions = Array.from({ length: 55 }, (_, index) => codexSession(root, `session-${String(index).padStart(2, "0")}`, [
    { timestamp: `2026-07-25T10:${String(index).padStart(2, "0")}:00.000Z`, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `hello ${index}` }] } },
  ], {
    firstTsMs: Date.parse("2026-07-25T10:00:00.000Z") + index * 60_000,
    lastTsMs: Date.parse("2026-07-25T10:00:00.000Z") + index * 60_000,
    isArchived: index === 54,
  }));

  const uncapped = buildForwardMatrixPlan(sessions, { claudeHome, bridgeRoot, selection: { archive: "all" } });
  assert.equal(uncapped.file.plan.sessions.length, 55);

  const existing = sessions[4]!;
  const existingPath = targetPathFor(claudeHome, existing).targetPath;
  fs.mkdirSync(path.dirname(existingPath), { recursive: true });
  fs.writeFileSync(existingPath, "existing\n");
  const selected = buildForwardMatrixPlan(sessions, {
    claudeHome,
    bridgeRoot,
    selection: {
      archive: "active",
      projectScope: "existing-targets",
      sessionIds: [existing.sessionId],
      fromMs: existing.lastTsMs!,
      toMs: existing.lastTsMs!,
      limit: 1,
    },
  });
  assert.deepEqual(selected.file.plan.sessions.map((row) => row.sessionId), [existing.sessionId]);
  assert.equal(selected.file.target.sessions[0]?.targetExists, true);
  assert.equal(selected.file.target.sessions[0]?.targetPath, fs.realpathSync.native(existingPath));

  const archived = buildForwardMatrixPlan(sessions, {
    claudeHome, bridgeRoot, selection: { archive: "archived", limit: 1 },
  });
  assert.deepEqual(archived.file.plan.sessions.map((row) => row.sessionId), [sessions[54]!.sessionId]);
});

test("Claude wrapper identity must agree with every transcript identity", () => {
  const desktop = {
    cliSessionId: "cli-1", sessionId: "local-1", wrapperSessionId: "local-1",
    wrapperPath: "wrapper.json", cwd: "C:\\Repo", title: "x", isArchived: false,
    createdAtMs: null, lastActivityAtMs: null, transcriptPath: "cli-1.jsonl",
    transcriptExists: true, transcriptStatus: "available",
  } satisfies ClaudeDesktopSourceSession;
  const transcript = {
    sourcePath: "cli-1.jsonl", contentSha256: "a".repeat(64), records: [],
    sessionId: "cli-1", sessionIds: ["cli-1"], cwd: "c:\\repo", cwds: ["c:\\repo"], title: null,
  } satisfies ClaudeSourceTranscript;
  assert.equal(transcriptIdentityError(desktop, transcript), null);
  assert.match(transcriptIdentityError(desktop, { ...transcript, sessionIds: ["cli-1", "other"] }) ?? "", /session id/);
  assert.match(transcriptIdentityError(desktop, { ...transcript, cwds: ["D:\\other"] }) ?? "", /cwd/);
});

test("only ordered, structurally valid tool pairs are eligible for native rendering", () => {
  const base = {
    id: "event", sourceEnvelopeId: "envelope", path: "$.message.content[0]",
    timestamp: null, safety: HISTORICAL_SAFETY,
  };
  const call = (id: string, name: string | null, input: unknown): BridgeEvent => ({
    ...base, id: `call-${id}`, kind: "tool_use", toolUseId: id, name, input,
  });
  const result = (id: string): BridgeEvent => ({
    ...base, id: `result-${id}`, kind: "tool_result", toolUseId: id,
    content: "done", isError: false,
  });

  assert.deepEqual([...nativeToolUseIds([call("ok", "Read", {}), result("ok")])], ["ok"]);
  assert.equal(nativeToolUseIds([call("missing-name", null, {}), result("missing-name")]).size, 0);
  assert.equal(nativeToolUseIds([call("bad-input", "Read", "path") , result("bad-input")]).size, 0);
  assert.equal(nativeToolUseIds([result("reversed"), call("reversed", "Read", {})]).size, 0);
});

test("CLI aggregate errors expose every preserved primary and cleanup cause", () => {
  const rendered = formatCliError(new AggregateError([
    new Error("target write failed"),
    new AggregateError([new Error("rollback failed"), new Error("close failed")], "cleanup failed"),
  ], "operation and cleanup failed"));
  assert.match(rendered, /operation and cleanup failed/);
  assert.match(rendered, /target write failed/);
  assert.match(rendered, /rollback failed/);
  assert.match(rendered, /close failed/);
});
