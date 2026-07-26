import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  matrixPlanDigest,
  buildForwardMatrixPlan,
  bridgeToLogical,
  beginReverseApply,
  assertGoalMigrationReady,
  assertCodexTargetSnapshot,
  forwardLossObservations,
  main,
  nativeToolUseIds,
  recoverCodexOperation,
  formatCliError,
  goalMigrationModeOption,
  inspectReverseStaticPreflight,
  selectionFromPlan,
  selectionOptions,
  transcriptIdentityError,
  type MatrixForwardPlanFile,
  type MatrixPlanFile,
} from "../src/matrix-cli.ts";
import { buildImportPlan, type ImportPlan } from "../src/import-plan.ts";
import { planGoalMigration } from "../src/goal.ts";
import { CLAUDE_GOAL_TARGET_CAPABILITY_ID } from "../src/claude-goal-target.ts";
import { CODEX_GOAL_TARGET_CAPABILITY_ID } from "../src/codex-goal-target.ts";
import type { ClaudeDesktopSourceSession } from "../src/claude-desktop-source.ts";
import type { ClaudeSourceTranscript } from "../src/claude-source.ts";
import { HISTORICAL_SAFETY, type BridgeEvent } from "../src/ir.ts";
import type { CodexSession } from "../src/types.ts";
import { targetPathFor } from "../src/claude-target.ts";
import { probeCodexPrivateWriteProfile, SUPPORTED_CODEX_TARGET } from "../src/version-gate.ts";
import { readClaudeJsonl } from "../src/claude-source.ts";
import { claudeTranscriptToIr } from "../src/claude-to-ir.ts";
import { buildCodexRollout41059 } from "../src/compat/codex/v26_721_41059.ts";
import { operationJournalInputForPlan, planCodexTarget } from "../src/codex-target.ts";
import { createOperationJournal } from "../src/operation-journal.ts";

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
    version: 3,
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
    schema: "agentryx.import-plan/v4",
    direction: "claude-to-codex",
    renderMode: "semantic",
    goalMode: "migrate",
    plan: {
      version: 3,
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
      privateWriteProfile: probeCodexPrivateWriteProfile({
        internalVersion: "26.721.41059", appAsarSha256: "a", codexExeSha256: "b",
      }),
      goalCapabilityId: "codex.goal-app-server/v1",
      goalCapabilityFingerprint: "c".repeat(64),
      sessions: [],
    },
  };
  const semantic = matrixPlanDigest(base);
  assert.notEqual(matrixPlanDigest({ ...base, renderMode: "verbatim" }), semantic);
  assert.notEqual(matrixPlanDigest({ ...base, goalMode: "skip" }), semantic);
  assert.notEqual(matrixPlanDigest({
    ...base,
    target: { ...base.target, goalCapabilityFingerprint: "d".repeat(64) },
  }), semantic);
  assert.notEqual(matrixPlanDigest({
    ...base,
    target: {
      ...base.target,
      privateWriteProfile: {
        ...base.target.privateWriteProfile,
        artifactFingerprint: "d".repeat(64),
      },
    },
  }), semantic);
  assert.notEqual(matrixPlanDigest({ ...base, target: { ...base.target, codexHome: "D:\\.codex" } }), semantic);
  assert.notEqual(matrixPlanDigest({
    ...base,
    target: { ...base.target, evidence: { ...base.target.evidence, appAsarSha256: "changed" } },
  }), semantic);
});

test("Goal mode CLI defaults independently and rejects contradictory aliases", () => {
  assert.equal(goalMigrationModeOption(["plan", "--render-mode", "verbatim"]), "migrate");
  assert.equal(goalMigrationModeOption(["plan", "--goal-mode", "skip"]), "skip");
  assert.equal(goalMigrationModeOption(["plan", "--no-migrate-goal"]), "skip");
  assert.equal(goalMigrationModeOption(["plan", "--goal-mode=skip", "--no-migrate-goal"]), "skip");
  assert.throws(() => goalMigrationModeOption([
    "plan", "--goal-mode", "migrate", "--no-migrate-goal",
  ]), /contradicts/);
  assert.throws(() => goalMigrationModeOption([
    "plan", "--goal-mode", "migrate", "--goal-mode", "skip",
  ]), /conflicting/);
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

function createForwardIndex(codexHome: string): DatabaseSync {
  fs.mkdirSync(codexHome, { recursive: true });
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT, name TEXT,
    first_user_message TEXT, source TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER,
    updated_at INTEGER, sandbox_policy TEXT, approval_mode TEXT, reasoning_effort TEXT,
    archived INTEGER, archived_at INTEGER
  ); CREATE TABLE thread_spawn_edges (child_thread_id TEXT)`);
  return db;
}

function writeIndexedRollout(dir: string, id: string, cwd: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const rolloutPath = path.join(dir, `rollout-2026-07-25T10-00-00-${id}.jsonl`);
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id, cwd, source: "vscode" } }),
    JSON.stringify({ timestamp: "2026-07-25T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: id }] } }),
  ].join("\n") + "\n");
  return rolloutPath;
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
    { timestamp: "2026-07-25T10:00:08.000Z", type: "compacted", payload: { replacement_history: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "compact summary" }] },
    ] } },
  ]);

  const first = buildForwardMatrixPlan([session], {
    claudeHome,
    bridgeRoot,
    selection: { archive: "all" },
    renderMode: "semantic",
    goalMode: "migrate",
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
  assert.equal(first.file.target.renderPolicy.goalCapabilityId, CLAUDE_GOAL_TARGET_CAPABILITY_ID);
  assert.match(first.file.target.renderPolicy.goalCapabilityFingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(matrixPlanDigest({
    schema: first.file.schema,
    direction: first.file.direction,
    renderMode: first.file.renderMode,
    goalMode: first.file.goalMode,
    plan: first.file.plan,
    target: {
      ...first.file.target,
      renderPolicy: { ...first.file.target.renderPolicy, goalCapabilityFingerprint: "changed" },
    },
  }), first.file.digest);
  assert.equal(first.file.target.sessions[0]?.targetPath, path.resolve(targetPathFor(claudeHome, session).targetPath));
  assert.equal(first.file.target.sessions[0]?.targetConversationExists, false);
  assert.equal(first.file.target.sessions[0]?.sourceCodexRolloutId, session.sessionId);
  assert.equal(first.file.target.sessions[0]?.sourceCodexThreadId, session.desktopThreadId ?? null);
  assert.equal(first.file.target.sessions[0]?.targetClaudeCliSessionId, session.sessionId);
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
      "reasoning_rendered_as_inert_metadata",
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
    schema: "agentryx.import-plan/v4" as const,
    direction: "claude-to-codex" as const,
    renderMode: first.file.renderMode,
    goalMode: first.file.goalMode,
    plan: first.file.plan,
    target: {
      codexHome: path.join(root, "codex"), dbPath: path.join(root, "state.sqlite"), bridgeRoot,
      evidence: { internalVersion: "26.721.41059", appAsarSha256: "a", codexExeSha256: "b" }, sessions: [],
      privateWriteProfile: probeCodexPrivateWriteProfile({
        internalVersion: "26.721.41059", appAsarSha256: "a", codexExeSha256: "b",
      }),
      goalCapabilityId: "codex.goal-app-server/v1" as const,
      goalCapabilityFingerprint: "c".repeat(64),
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
    { ...base, id: "image", kind: "media", mediaType: "image", source: "data:image/png;base64,AA==", metadata: {}, role: "user", authoredByHuman: true },
    { ...base, id: "compact", kind: "compact_boundary", compactMetadata: {}, activeContextStartsAfter: true },
  ];
  assert.deepEqual(forwardLossObservations(events, "semantic"), [{
    kind: "reasoning_rendered_as_inert_metadata", count: 1,
  }]);
  const unsupportedImages: BridgeEvent[] = [
    { ...base, id: "url", kind: "media", mediaType: "image", source: "https://example.com/image.png", metadata: {}, role: "user", authoredByHuman: true },
    { ...base, id: "mime", kind: "media", mediaType: "image", source: "data:image/svg+xml;base64,PHN2Zz4=", metadata: {}, role: "user", authoredByHuman: true },
    { ...base, id: "base64", kind: "media", mediaType: "image", source: "data:image/png;base64,%%%", metadata: {}, role: "user", authoredByHuman: true },
  ];
  assert.deepEqual(forwardLossObservations(unsupportedImages, "semantic"), [{
    kind: "unsupported_image_sidecar_only", count: 3,
  }]);
  assert.deepEqual(forwardLossObservations(events, "verbatim"), [{
    kind: "verbatim_semantics_intentionally_inert", count: 4,
    detail: "Canonical source text is preserved, but source-native semantics are not activated in Claude.",
  }]);
});

test("forward apply requires confirmation before any mutation", () => {
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
    /forward apply requires --confirm/,
  );
  assert.equal(fs.existsSync(path.join(root, "bridge")), false);
});

test("forward CLI dry-run is zero-mutation and confirmed apply writes transcript plus archived wrapper", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-forward-e2e-"));
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  const bridgeRoot = path.join(root, "bridge");
  const workspaceDir = path.join(root, "workspace");
  const archived = path.join(codexHome, "archived_sessions");
  fs.mkdirSync(archived, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const id = "12345678-1234-4234-8234-123456789abc";
  fs.writeFileSync(path.join(archived, `rollout-2026-07-25T10-00-00-${id}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id, cwd: path.join(root, "repo"), source: "vscode" } }),
    JSON.stringify({ timestamp: "2026-07-25T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello matrix" }] } }),
  ].join("\n") + "\n", "utf8");
  const planPath = path.join(root, "plan.json");
  main(["plan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", claudeHome, "--bridge-root", bridgeRoot, "--workspace-dir", workspaceDir,
    "--archive", "all", "--out", planPath]);
  const stored = JSON.parse(fs.readFileSync(planPath, "utf8")) as MatrixForwardPlanFile;
  const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
  main(["apply", "--plan", planPath, "--confirm", stored.digest, "--dry-run"]);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).map(String).sort(), before);
  main(["apply", "--plan", planPath, "--confirm", stored.digest]);
  assert.doesNotThrow(() => main(["apply", "--plan", planPath, "--confirm", stored.digest]));
  const target = stored.target.sessions[0]!;
  assert.equal(fs.existsSync(target.targetPath), true);
  assert.equal(fs.existsSync(target.wrapperPath!), true);
  const wrapper = JSON.parse(fs.readFileSync(target.wrapperPath!, "utf8")) as { isArchived: boolean; cliSessionId: string };
  assert.equal(wrapper.isArchived, true);
  assert.equal(wrapper.cliSessionId, id);
});

test("persisted v3 envelopes and nested v2 plans require regeneration before apply", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-legacy-goal-"));
  for (const direction of ["claude-to-codex", "codex-to-claude"] as const) {
    const planPath = path.join(root, `${direction}.json`);
    fs.writeFileSync(planPath, JSON.stringify({
      schema: "agentryx.import-plan/v3", direction, renderMode: "semantic", goalMode: "skip",
      digest: "old-digest",
      plan: { version: 2, selection: {}, sessions: [], losses: {} },
      target: {},
    }));
    assert.throws(() => main(["apply", "--plan", planPath]), /regenerate plan with current threadpass/);
  }
});

test("active migrate fails closed while skip and historical-only decisions are ready", () => {
  const decision = (mode: "migrate" | "skip", eligible: boolean) => ({
    mode, sourceGoalSha256: "a".repeat(64),
    eligibility: eligible ? "eligible" as const : "ineligible" as const,
    sourceStatus: eligible ? "active" as const : "complete" as const,
    status: mode === "skip" ? "skipped_by_policy" as const
      : eligible ? "pending_target_implementation" as const : "historical_only" as const,
    targetCapabilityId: null, targetGoalId: null,
  });
  const plan = (goalDecision: ReturnType<typeof decision>) => buildImportPlan([{
    sessionId: "goal", cwd: "C:/repo", isArchived: false, goalDecision,
  }]).plan;
  assert.throws(() => assertGoalMigrationReady(plan(decision("migrate", true)), "migrate"), /not implemented/);
  assert.doesNotThrow(() => assertGoalMigrationReady(plan(decision("skip", true)), "skip"));
  assert.doesNotThrow(() => assertGoalMigrationReady(plan(decision("migrate", false)), "migrate"));
  const absent = buildImportPlan([{
    sessionId: "none", cwd: "C:/repo", isArchived: false, goalDecision: planGoalMigration(null),
  }]).plan;
  assert.doesNotThrow(() => assertGoalMigrationReady(absent, "migrate"));
  assert.ok(plan(decision("skip", true)).losses.byKind.some((loss) =>
    loss.kind === "goal_migration_skipped_by_policy"));
});

test("only the wired Claude Goal capability is accepted as ready", () => {
  const ready = buildImportPlan([{
    sessionId: "ready", cwd: "C:/repo", isArchived: false,
    goalDecision: planGoalMigration({
      version: 1, authority: "native-store", provider: "codex", sourceThreadId: "ready",
      sourceGoalId: "g", objective: "ship", status: "active", migrationEligible: true,
      tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAtMs: 1, updatedAtMs: 1,
      locator: { sourcePath: "C:/goals.sqlite", recordIndex: null, table: "thread_goals", key: "ready" },
      sourceSha256: "a".repeat(64),
    }, "migrate", CLAUDE_GOAL_TARGET_CAPABILITY_ID),
  }]).plan;
  assert.throws(() => assertGoalMigrationReady(ready, "migrate"), /not wired/);
  assert.doesNotThrow(() => assertGoalMigrationReady(ready, "migrate", CLAUDE_GOAL_TARGET_CAPABILITY_ID));
});

test("Goal readiness is direction-specific for the Codex app-server capability", () => {
  const ready = buildImportPlan([{
    sessionId: "reverse-ready", cwd: "C:/repo", isArchived: false,
    goalDecision: planGoalMigration({
      version: 1, authority: "native-transcript", provider: "claude", sourceThreadId: "reverse-ready",
      sourceGoalId: null, objective: "ship", status: "active", migrationEligible: true,
      tokenBudget: null, tokensUsed: null, timeUsedSeconds: null, createdAtMs: 1, updatedAtMs: 1,
      locator: { sourcePath: "C:/claude.jsonl", recordIndex: 0, table: null, key: "reverse-ready" },
      sourceSha256: "b".repeat(64),
    }, "migrate", CODEX_GOAL_TARGET_CAPABILITY_ID),
  }]).plan;
  assert.doesNotThrow(() => assertGoalMigrationReady(ready, "migrate", CODEX_GOAL_TARGET_CAPABILITY_ID));
  assert.throws(() => assertGoalMigrationReady(ready, "migrate", CLAUDE_GOAL_TARGET_CAPABILITY_ID), /not wired/);
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
    "--project", "FixtureProject", "--no-register", "--out", out,
  ]);

  const stored = JSON.parse(fs.readFileSync(out, "utf8")) as MatrixPlanFile;
  assert.equal(stored.direction, "codex-to-claude");
  assert.deepEqual(
    stored.plan.sessions.map((session) => session.sessionId).sort(),
    [archivedId, sessionId].sort(),
  );
  assert.equal(stored.plan.sessions.find((session) => session.sessionId === archivedId)?.archiveState, "archived");
  assert.ok(stored.plan.sessions.every((session) => session.projectName === "FixtureProject"));
  assert.equal(fs.existsSync(claudeHome), false);
  assert.equal(fs.existsSync(bridgeRoot), false);
});

test("forward scan preserves malformed indexed archive columns as unknown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-forward-archive-malformed-"));
  const codexHome = path.join(root, "codex");
  const cwd = path.join(root, "repo");
  const id = "11111111-aaaa-4bbb-8ccc-222222222222";
  const rolloutPath = writeIndexedRollout(path.join(codexHome, "sessions", "2026", "07", "25"), id, cwd);
  const db = createForwardIndex(codexHome);
  db.prepare(`INSERT INTO threads (
    id, rollout_path, cwd, title, source, recency_at_ms, archived, archived_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, rolloutPath, cwd, id, "vscode", 1, 1, "malformed");
  db.close();
  const out = path.join(root, "scan.json");
  main(["scan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", path.join(root, "claude"), "--archive", "all", "--out", out]);
  const scan = JSON.parse(fs.readFileSync(out, "utf8")) as {
    inventory: { unknownArchive: number };
    selected: Array<{ archiveState: string; archiveProvenance: string }>;
  };
  assert.equal(scan.inventory.unknownArchive, 1);
  assert.equal(scan.selected[0]?.archiveState, "unknown");
  assert.equal(scan.selected[0]?.archiveProvenance, "codex-thread-index-invalid-archive-columns");
  assert.throws(() => main(["scan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", path.join(root, "claude"), "--archive", "active", "--out", path.join(root, "active.json")]),
  /archive state is unknown/);
  const planPath = path.join(root, "plan.json");
  const claudeHome = path.join(root, "claude-target");
  const bridgeRoot = path.join(root, "bridge");
  main(["plan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", claudeHome, "--bridge-root", bridgeRoot, "--archive", "all",
    "--goal-mode", "skip", "--no-register", "--out", planPath]);
  const stored = JSON.parse(fs.readFileSync(planPath, "utf8")) as MatrixForwardPlanFile;
  assert.throws(() => main(["apply", "--plan", planPath, "--confirm", stored.digest]),
    /source archive state is unknown; target write refused/);
  assert.equal(fs.existsSync(claudeHome), false);
  assert.equal(fs.existsSync(bridgeRoot), false);
});

test("forward scan reports both indexed archive and rollout-location disagreements", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-forward-archive-conflict-"));
  const codexHome = path.join(root, "codex");
  const cwd = path.join(root, "repo");
  const activeDbId = "33333333-aaaa-4bbb-8ccc-444444444444";
  const archivedDbId = "55555555-aaaa-4bbb-8ccc-666666666666";
  const physicallyArchived = writeIndexedRollout(path.join(codexHome, "archived_sessions"), activeDbId, cwd);
  const physicallyActive = writeIndexedRollout(path.join(codexHome, "sessions", "2026", "07", "25"), archivedDbId, cwd);
  const db = createForwardIndex(codexHome);
  const insert = db.prepare(`INSERT INTO threads (
    id, rollout_path, cwd, title, source, recency_at_ms, archived, archived_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(activeDbId, physicallyArchived, cwd, activeDbId, "vscode", 2, 0, null);
  insert.run(archivedDbId, physicallyActive, cwd, archivedDbId, "vscode", 1, 1, 1_700_000_000);
  db.close();
  const out = path.join(root, "scan.json");
  main(["scan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", path.join(root, "claude"), "--archive", "all", "--out", out]);
  const scan = JSON.parse(fs.readFileSync(out, "utf8")) as {
    inventory: { unknownArchive: number };
    selected: Array<{ archiveState: string; archiveProvenance: string }>;
  };
  assert.equal(scan.inventory.unknownArchive, 2);
  assert.deepEqual(scan.selected.map((session) => session.archiveState), ["unknown", "unknown"]);
  assert.ok(scan.selected.every((session) =>
    session.archiveProvenance === "codex-thread-index-rollout-location-conflict"));
  for (const archive of ["active", "archived"]) {
    assert.throws(() => main(["scan", "--direction", "codex-to-claude", "--codex-home", codexHome,
      "--claude-home", path.join(root, "claude"), "--archive", archive, "--out", path.join(root, `${archive}.json`)]),
    /archive state is unknown/);
  }
});

test("forward selection treats existing-targets as a project-root filter and reports conversation collisions separately", () => {
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
  const projectOnly = sessions[3]!;
  const projectOnlyPath = targetPathFor(claudeHome, projectOnly).targetPath;
  fs.mkdirSync(path.dirname(projectOnlyPath), { recursive: true });
  fs.writeFileSync(existingPath, "existing\n");
  const selected = buildForwardMatrixPlan(sessions, {
    claudeHome,
    bridgeRoot,
    selection: {
      archive: "active",
      projectScope: "existing-targets",
      sessionIds: [projectOnly.sessionId, existing.sessionId],
      fromMs: existing.lastTsMs!,
      toMs: existing.lastTsMs!,
      limit: 1,
    },
  });
  assert.deepEqual(selected.file.plan.sessions.map((row) => row.sessionId), [existing.sessionId]);
  assert.equal(selected.file.target.sessions[0]?.targetProjectExists, true);
  assert.equal(selected.file.target.sessions[0]?.targetConversationExists, true);
  assert.equal(selected.file.target.sessions[0]?.targetConversationState, "collision");
  assert.equal(selected.file.target.sessions[0]?.targetPath, fs.realpathSync.native(existingPath));

  const projectSelected = buildForwardMatrixPlan([projectOnly], {
    claudeHome, bridgeRoot,
    selection: { archive: "all", projectScope: "existing-targets" },
  });
  assert.equal(projectSelected.file.plan.sessions[0]?.targetProjectExists, true);
  assert.equal(projectSelected.file.plan.sessions[0]?.targetConversationExists, false);

  fs.writeFileSync(
    projectSelected.applyPlans[0]!.transcript.path,
    projectSelected.applyPlans[0]!.transcript.afterContents,
  );
  const exact = buildForwardMatrixPlan([projectOnly], {
    claudeHome, bridgeRoot, selection: { archive: "all" },
  });
  assert.equal(exact.file.target.sessions[0]?.targetConversationState, "exact-existing");
  assert.equal(exact.file.plan.sessions[0]?.targetConversationState, "exact-existing");
  assert.notEqual(exact.file.digest, projectSelected.file.digest, "target existence is plan-bound");

  const archived = buildForwardMatrixPlan(sessions, {
    claudeHome, bridgeRoot, selection: { archive: "archived", limit: 1 },
  });
  assert.deepEqual(archived.file.plan.sessions.map((row) => row.sessionId), [sessions[54]!.sessionId]);

  fs.rmSync(path.dirname(projectOnlyPath), { recursive: true });
  assert.throws(() => buildForwardMatrixPlan(sessions, {
    claudeHome,
    bridgeRoot,
    selection: { archive: "all", projectScope: "existing-targets" },
    expectedTargets: projectSelected.file.target.sessions,
  }), /target project ceased to exist/);
  assert.equal(fs.existsSync(bridgeRoot), false, "apply rebuild must fail before bridge or target mutation");
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
    id: "event", path: "$.message.content[0]",
    timestamp: null, safety: HISTORICAL_SAFETY,
  };
  const call = (
    id: string, name: string | null, input: unknown,
  ): Extract<BridgeEvent, { kind: "tool_use" }> => ({
    ...base, id: `call-${id}`, sourceEnvelopeId: "assistant-envelope",
    sourceRecordUuid: "assistant-record", sourceParentUuid: "prior-record",
    kind: "tool_use", role: "assistant", toolUseId: id, name, input,
  });
  const result = (id: string): Extract<BridgeEvent, { kind: "tool_result" }> => ({
    ...base, id: `result-${id}`, sourceEnvelopeId: "user-envelope",
    sourceRecordUuid: "user-record", sourceParentUuid: "assistant-record",
    kind: "tool_result", role: "user", toolUseId: id,
    content: "done", isError: false,
  });

  assert.deepEqual([...nativeToolUseIds([call("ok", "Read", {}), result("ok")])], ["ok"]);
  assert.deepEqual(
    [...nativeToolUseIds([
      call("one", "Read", { file_path: "a" }),
      call("two", "Read", { file_path: "b" }),
      result("one"),
      result("two"),
    ])],
    ["one", "two"],
  );
  assert.equal(nativeToolUseIds([call("missing-name", null, {}), result("missing-name")]).size, 0);
  assert.equal(nativeToolUseIds([call("bad-input", "Read", "path") , result("bad-input")]).size, 0);
  assert.equal(nativeToolUseIds([result("reversed"), call("reversed", "Read", {})]).size, 0);
  assert.equal(nativeToolUseIds([
    call("same-envelope", "Read", {}),
    { ...result("same-envelope"), sourceEnvelopeId: "assistant-envelope" },
  ]).size, 0);
  assert.equal(nativeToolUseIds([
    call("wrong-parent", "Read", {}),
    { ...result("wrong-parent"), sourceParentUuid: "different-assistant" },
  ]).size, 0);
  assert.equal(nativeToolUseIds([
    call("missing-parent", "Read", {}),
    { ...result("missing-parent"), sourceParentUuid: null },
  ]).size, 0);
  assert.equal(nativeToolUseIds([{ ...call("wrong-call-role", "Read", {}), role: "user" }, result("wrong-call-role")]).size, 0);
  assert.equal(nativeToolUseIds([call("wrong-result-role", "Read", {}), { ...result("wrong-result-role"), role: "assistant" }]).size, 0);
  assert.equal(nativeToolUseIds([
    call("duplicate", "Read", {}),
    call("duplicate", "Read", {}),
    result("duplicate"),
    result("duplicate"),
  ]).size, 0);
  assert.equal(nativeToolUseIds([
    call("split-one", "Read", {}),
    { ...call("split-two", "Read", {}), sourceEnvelopeId: "second-assistant-envelope", sourceRecordUuid: "second-assistant-record" },
    result("split-one"),
    result("split-two"),
  ]).size, 0);
  assert.equal(nativeToolUseIds([
    call("result-one", "Read", {}),
    call("result-two", "Read", {}),
    result("result-one"),
    { ...result("result-two"), sourceEnvelopeId: "second-user-envelope", sourceRecordUuid: "second-user-record" },
  ]).size, 0);
  assert.equal(nativeToolUseIds([
    call("interleaved", "Read", {}),
    { ...base, id: "middle", sourceEnvelopeId: "assistant-envelope", kind: "text", role: "assistant", text: "middle", authoredByHuman: false },
    result("interleaved"),
  ]).size, 0);
});

test("scan exposes unreadable Desktop membership and membership filters fail without mutating global state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-membership-unknown-"));
  const codexHome = path.join(root, "codex");
  const sourceDir = path.join(codexHome, "sessions", "2026", "07", "27");
  fs.mkdirSync(sourceDir, { recursive: true });
  const id = "12345678-aaaa-4bbb-8ccc-123456789abc";
  fs.writeFileSync(path.join(sourceDir, `rollout-2026-07-27T10-00-00-${id}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-27T10:00:00.000Z", type: "session_meta", payload: { id, cwd: path.join(root, "repo"), source: "vscode" } }),
    JSON.stringify({ timestamp: "2026-07-27T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } }),
  ].join("\n") + "\n");
  const globalState = path.join(codexHome, ".codex-global-state.json");
  fs.writeFileSync(globalState, "{broken", "utf8");
  const before = fs.readFileSync(globalState);
  const out = path.join(root, "scan.json");

  main(["scan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", path.join(root, "claude"), "--archive", "all", "--out", out]);
  const scan = JSON.parse(fs.readFileSync(out, "utf8")) as {
    inventory: { projectMembership: { status: string } };
    selected: Array<{ projectMembership: string; projectMembershipProvenance: string }>;
  };
  assert.equal(scan.inventory.projectMembership.status, "unreadable");
  assert.equal(scan.selected[0]?.projectMembership, "unknown");
  assert.equal(scan.selected[0]?.projectMembershipProvenance, "codex-global-state-unavailable");
  assert.deepEqual(fs.readFileSync(globalState), before);
  assert.throws(() => main(["scan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", path.join(root, "claude"), "--project-scope", "projectless"]), /membership is unknown/);
});

test("typed rollout walk does not cwd-infer an ID absent from authoritative assignments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-membership-assigned-"));
  const codexHome = path.join(root, "codex");
  const repo = path.join(root, "repo");
  const sourceDir = path.join(codexHome, "sessions", "2026", "07", "27");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  const id = "12345678-bbbb-4ccc-8ddd-123456789abc";
  fs.writeFileSync(path.join(sourceDir, `rollout-2026-07-27T10-00-00-${id}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-27T10:00:00.000Z", type: "session_meta", payload: { id, cwd: repo, source: "vscode" } }),
    JSON.stringify({ timestamp: "2026-07-27T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { project: { name: "Repo", rootPaths: [repo] } },
    "thread-project-assignments": {},
    "projectless-thread-ids": [],
  }));
  const out = path.join(root, "scan.json");

  main(["scan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", path.join(root, "claude"), "--archive", "all", "--out", out]);
  const scan = JSON.parse(fs.readFileSync(out, "utf8")) as {
    inventory: { projectMembership: { status: string } };
    selected: Array<{ projectMembership: string; projectMembershipProvenance: string }>;
  };
  assert.equal(scan.inventory.projectMembership.status, "available");
  assert.equal(scan.selected[0]?.projectMembership, "unknown");
  assert.equal(scan.selected[0]?.projectMembershipProvenance, "codex-global-state-unavailable");
  assert.throws(() => main(["scan", "--direction", "codex-to-claude", "--codex-home", codexHome,
    "--claude-home", path.join(root, "claude"), "--archive", "all", "--project-scope", "projects"]), /membership is unknown/);
});

test("reverse scan exposes unknown wrapper archive state and archive filters fail visibly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-archive-unknown-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "local_unknown.json"), JSON.stringify({
    sessionId: "local_unknown", cwd: path.join(root, "repo"), transcriptUnavailable: true,
  }));
  const out = path.join(root, "scan.json");
  const base = ["scan", "--direction", "claude-to-codex", "--workspace-dir", workspace,
    "--claude-home", path.join(root, "claude"), "--codex-home", path.join(root, "codex")];

  main([...base, "--archive", "all", "--out", out]);
  const scan = JSON.parse(fs.readFileSync(out, "utf8")) as {
    inventory: { active: number; archived: number; unknownArchive: number };
    selected: Array<{ archiveState: string; archiveProvenance: string }>;
  };
  assert.deepEqual(scan.inventory, {
    total: 1, selected: 1, active: 0, archived: 0, unknownArchive: 1, unavailable: 1,
  });
  assert.equal(scan.selected[0]?.archiveState, "unknown");
  assert.equal(scan.selected[0]?.archiveProvenance, "claude-wrapper-missing-isArchived");
  assert.throws(() => main([...base, "--archive", "active"]), /archive state is unknown/);
  assert.throws(() => main([...base, "--archive", "archived"]), /archive state is unknown/);
});

test("Claude compact boundary plus following summary becomes nonempty resumable replacement history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-reverse-compact-"));
  const cwdVariant = path.join(root, "project", "nested", "..");
  fs.mkdirSync(path.join(root, "project", "nested"), { recursive: true });
  const transcriptPath = path.join(root, "compact.jsonl");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const records = [
    { type: "system", subtype: "compact_boundary", sessionId, timestamp: "2026-07-26T00:00:00.000Z", compactMetadata: { trigger: "auto", preTokens: 500000, postTokens: 2000 } },
    { type: "user", sessionId, timestamp: "2026-07-26T00:00:00.001Z", isCompactSummary: true, message: { role: "user", content: "authoritative compact summary" } },
    { type: "user", sessionId, timestamp: "2026-07-26T00:00:01.000Z", message: { role: "user", content: "continue from here" } },
  ];
  fs.writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const bundle = claudeTranscriptToIr(readClaudeJsonl(transcriptPath));
  const logical = bridgeToLogical({
    desktop: {
      wrapperPath: path.join(root, "wrapper.json"), wrapperSessionId: sessionId,
      cliSessionId: sessionId, sessionId, cwd: cwdVariant, title: "compact", isArchived: false,
      createdAtMs: Date.parse("2026-07-26T00:00:00.000Z"), lastActivityAtMs: Date.parse("2026-07-26T00:00:01.000Z"),
      transcriptPath, transcriptExists: true, transcriptStatus: "available",
    },
    bundle,
    summary: { sessionId, cwd: cwdVariant, hasProject: true, isArchived: false, targetProjectExists: false },
  }, "semantic");
  assert.equal(logical.compaction?.summary, "authoritative compact summary");
  assert.equal(logical.cwd, fs.realpathSync.native(path.join(root, "project")));
  const rollout = buildCodexRollout41059({ ...logical, threadId: sessionId });
  const compacted = rollout.find((line) => line.type === "compacted");
  assert.ok(compacted);
  assert.equal((compacted.payload.replacement_history as unknown[]).length, 1);
  assert.match(JSON.stringify(compacted.payload.replacement_history), /authoritative compact summary/);
});

test("semantic reverse rendering keeps the latest compact summary and appends post-boundary items exactly once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-reverse-latest-compact-"));
  const transcriptPath = path.join(root, "compact.jsonl");
  const sessionId = "19191919-1919-4191-8191-191919191919";
  const records = [
    { type: "system", subtype: "compact_boundary", sessionId, timestamp: "2026-07-26T00:00:00.000Z", compactMetadata: { preTokens: 100, postTokens: 20 } },
    { type: "user", sessionId, timestamp: "2026-07-26T00:00:00.001Z", isCompactSummary: true, message: { role: "user", content: "old summary" } },
    { type: "user", sessionId, timestamp: "2026-07-26T00:00:01.000Z", message: { role: "user", content: "between boundaries" } },
    { type: "system", subtype: "compact_boundary", sessionId, timestamp: "2026-07-26T00:00:02.000Z", compactMetadata: { preTokens: 120, postTokens: 10 } },
    { type: "user", sessionId, timestamp: "2026-07-26T00:00:02.001Z", isCompactSummary: true, message: { role: "user", content: "latest summary" } },
    { type: "user", sessionId, timestamp: "2026-07-26T00:00:03.000Z", message: { role: "user", content: "active once" } },
  ];
  fs.writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const bundle = claudeTranscriptToIr(readClaudeJsonl(transcriptPath));
  const logical = bridgeToLogical({
    desktop: {
      wrapperPath: path.join(root, "local_wrapper.json"), wrapperSessionId: "local_wrapper",
      cliSessionId: sessionId, sessionId: "local_wrapper", cwd: root, title: "compact", isArchived: false,
      createdAtMs: null, lastActivityAtMs: null, transcriptPath, transcriptExists: true, transcriptStatus: "available",
    },
    bundle,
    summary: { sessionId: "local_wrapper", cwd: root, hasProject: true, isArchived: false, targetProjectExists: false },
  }, "semantic");
  assert.equal(logical.compaction?.summary, "latest summary");
  const rollout = JSON.stringify(buildCodexRollout41059({ ...logical, threadId: "target" }));
  assert.equal((rollout.match(/active once/g) ?? []).length, 1);
  assert.equal((rollout.match(/latest summary/g) ?? []).length, 1);
  assert.doesNotMatch(rollout, /old summary/);
});

test("Claude compact boundary without a summary fails closed instead of writing empty replacement history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-reverse-compact-fail-"));
  const transcriptPath = path.join(root, "compact.jsonl");
  const sessionId = "22222222-2222-4222-8222-222222222222";
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId, timestamp: "2026-07-26T00:00:00.000Z", compactMetadata: { trigger: "auto", postTokens: 1000 } }),
    JSON.stringify({ type: "user", sessionId, timestamp: "2026-07-26T00:00:01.000Z", message: { role: "user", content: "post compact" } }),
  ].join("\n") + "\n", "utf8");
  const bundle = claudeTranscriptToIr(readClaudeJsonl(transcriptPath));
  assert.throws(() => bridgeToLogical({
    desktop: {
      wrapperPath: path.join(root, "wrapper.json"), wrapperSessionId: sessionId,
      cliSessionId: sessionId, sessionId, cwd: root, title: "compact", isArchived: false,
      createdAtMs: null, lastActivityAtMs: null, transcriptPath, transcriptExists: true,
      transcriptStatus: "available",
    },
    bundle,
    summary: { sessionId, cwd: root, hasProject: true, isArchived: false, targetProjectExists: false },
  }, "semantic"), /no recoverable replacement summary/);
});

test("verbatim reverse rendering preserves compact source as inert history without requiring a summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-reverse-verbatim-compact-"));
  const transcriptPath = path.join(root, "compact.jsonl");
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const raw = [
    JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId, timestamp: "2026-07-26T00:00:00.000Z", compactMetadata: { trigger: "auto", postTokens: 1000 } }),
    JSON.stringify({ type: "user", sessionId, timestamp: "2026-07-26T00:00:01.000Z", message: { role: "user", content: "post compact" } }),
  ].join("\n") + "\n";
  fs.writeFileSync(transcriptPath, raw, "utf8");
  const bundle = claudeTranscriptToIr(readClaudeJsonl(transcriptPath));
  const logical = bridgeToLogical({
    desktop: {
      wrapperPath: path.join(root, "wrapper.json"), wrapperSessionId: sessionId,
      cliSessionId: sessionId, sessionId, cwd: root, title: "compact", isArchived: false,
      createdAtMs: null, lastActivityAtMs: null, transcriptPath, transcriptExists: true,
      transcriptStatus: "available",
    },
    bundle,
    summary: { sessionId, cwd: root, hasProject: true, isArchived: false, targetProjectExists: false },
  }, "verbatim");
  assert.equal(logical.compaction, undefined);
  assert.match(JSON.stringify(logical.items), /compact_boundary/);
  assert.match(JSON.stringify(logical.items), /post compact/);

  const oversizedPath = path.join(root, "oversized.jsonl");
  fs.writeFileSync(oversizedPath, `${JSON.stringify({
    type: "user", sessionId, timestamp: "2026-07-26T00:00:02.000Z",
    message: { role: "user", content: "x".repeat(240_000) },
  })}\n`, "utf8");
  const oversizedBundle = claudeTranscriptToIr(readClaudeJsonl(oversizedPath));
  const oversized = bridgeToLogical({
    desktop: {
      wrapperPath: path.join(root, "oversized-wrapper.json"), wrapperSessionId: sessionId,
      cliSessionId: sessionId, sessionId, cwd: root, title: "oversized", isArchived: false,
      createdAtMs: null, lastActivityAtMs: null, transcriptPath: oversizedPath,
      transcriptExists: true, transcriptStatus: "available",
    },
    bundle: oversizedBundle,
    summary: { sessionId, cwd: root, hasProject: true, isArchived: false, targetProjectExists: false },
  }, "verbatim");
  assert.throws(() => planCodexTarget(
    path.join(root, "codex"),
    path.join(root, "codex", "state_5.sqlite"),
    "oversized",
    oversizedBundle.conversation.sourceContentSha256,
    oversized,
  ), /UTF-8 bytes/);
});

function createFullThreadsDb(dbPath: string): void {
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
  } finally {
    db.close();
  }
}

test("reverse static preflight reports missing schema and orphan journal stages without mutation", () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-preflight-schema-"));
  const missingHome = path.join(missingRoot, "codex");
  fs.mkdirSync(missingHome);
  const missingDb = path.join(missingHome, "state_5.sqlite");
  const partial = new DatabaseSync(missingDb);
  partial.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  partial.close();
  const missingPlan = planCodexTarget(missingHome, missingDb, "missing", "a".repeat(64), {
    cwd: missingRoot, title: "missing schema", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user", text: "hello" }],
  });
  const missing = inspectReverseStaticPreflight([missingPlan], path.join(missingRoot, "bridge"), missingDb);
  assert.match(missing.blockers.join("\n"), /threads schema: unsupported Codex threads schema; missing/);
  const missingOutput = path.join(missingRoot, "output", "nested", "result.json");
  const missingLock = path.join(missingHome, ".agentryx-session-import-lock.sqlite");
  assert.throws(() => beginReverseApply(
    [missingPlan], path.join(missingRoot, "bridge"), missingDb, missingOutput, missingHome,
  ), /Codex static preflight failed/);
  assert.equal(fs.existsSync(path.dirname(missingOutput)), false);
  assert.equal(fs.existsSync(missingLock), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-preflight-journal-"));
  const codexHome = path.join(root, "codex");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(codexHome);
  const dbPath = path.join(codexHome, "state_5.sqlite");
  createFullThreadsDb(dbPath);
  const plan = planCodexTarget(codexHome, dbPath, "source", "b".repeat(64), {
    cwd: root, title: "orphan stage", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user", text: "hello" }],
  });
  fs.mkdirSync(path.dirname(plan.stagePath), { recursive: true });
  fs.writeFileSync(plan.stagePath, "partial", "utf8");
  const stageBefore = fs.readFileSync(plan.stagePath, "utf8");
  const staged = inspectReverseStaticPreflight([plan], bridgeRoot, dbPath);
  assert.match(staged.blockers.join("\n"), /orphaned target stage requires inspection/);
  assert.equal(fs.readFileSync(plan.stagePath, "utf8"), stageBefore);
  const stagedOutput = path.join(root, "output", "nested", "result.json");
  const lockPath = path.join(codexHome, ".agentryx-session-import-lock.sqlite");
  assert.throws(() => beginReverseApply(
    [plan], bridgeRoot, dbPath, stagedOutput, codexHome,
  ), /Codex static preflight failed/);
  assert.equal(fs.existsSync(path.dirname(stagedOutput)), false);
  assert.equal(fs.existsSync(lockPath), false);

  fs.rmSync(plan.stagePath);
  const journal = createOperationJournal(bridgeRoot, operationJournalInputForPlan(plan));
  const journalPath = path.join(bridgeRoot, "operations", `${plan.operationId}.json`);
  const journalBefore = fs.readFileSync(journalPath, "utf8");
  const journaled = inspectReverseStaticPreflight([plan], bridgeRoot, dbPath);
  assert.match(journaled.blockers.join("\n"), /operation journal is not retryable in state prepared/);
  assert.equal(fs.readFileSync(journalPath, "utf8"), journalBefore);
  assert.equal(journal.state, "prepared");
});

test("Codex batch snapshot revalidation rejects an artifact change before target mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-batch-evidence-"));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome);
  const dbPath = path.join(codexHome, "state_5.sqlite");
  createFullThreadsDb(dbPath);
  const plan = planCodexTarget(codexHome, dbPath, "source", "c".repeat(64), {
    cwd: root, title: "batch evidence", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user", text: "hello" }],
  });
  const evidence = { ...SUPPORTED_CODEX_TARGET };
  const profile = probeCodexPrivateWriteProfile(evidence);
  assert.doesNotThrow(() => assertCodexTargetSnapshot(
    evidence, profile, [plan], evidence, "at the Codex mutation batch boundary",
  ));
  assert.throws(() => assertCodexTargetSnapshot(
    evidence, profile, [plan], { ...evidence, codexExeSha256: "0".repeat(64) },
    "at the Codex mutation batch boundary",
  ), /changed at the Codex mutation batch boundary/);
});

test("Codex recover re-hashes under lock and blocks both recovery branches before mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-recover-evidence-"));
  const codexHome = path.join(root, "codex");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(codexHome);
  const dbPath = path.join(codexHome, "state_5.sqlite");
  createFullThreadsDb(dbPath);
  const plan = planCodexTarget(codexHome, dbPath, "source", "d".repeat(64), {
    cwd: root, title: "recover evidence", createdAt: "2026-07-26T00:00:00.000Z",
    messages: [{ role: "user", text: "hello" }],
  });
  const journal = createOperationJournal(bridgeRoot, operationJournalInputForPlan(plan));
  const preLockEvidence = { ...SUPPORTED_CODEX_TARGET };
  const driftedEvidence = { ...preLockEvidence, appAsarSha256: "0".repeat(64) };
  let desktopChecks = 0;
  let evidenceLoads = 0;
  let recoveryMutations = 0;
  let goalRpcFactories = 0;
  let goalReconciliations = 0;
  const dependencies = {
    desktopGuard: () => { desktopChecks += 1; },
    evidenceLoader: () => { evidenceLoads += 1; return driftedEvidence; },
    recoverFiles: () => { recoveryMutations += 1; return journal; },
    reconcileGoal: () => { goalReconciliations += 1; return journal; },
    goalRpcFactory: () => { goalRpcFactories += 1; throw new Error("must not create Goal RPC after drift"); },
  };

  assert.throws(() => recoverCodexOperation(
    journal, bridgeRoot, plan.operationId, codexHome, "manifest.json", preLockEvidence, dependencies,
  ), /changed under the recovery lock/);
  const goalJournal = {
    ...journal,
    state: "reconciliation-required" as const,
    goalActivation: {} as never,
  };
  assert.throws(() => recoverCodexOperation(
    goalJournal, bridgeRoot, plan.operationId, codexHome, "manifest.json", preLockEvidence, dependencies,
  ), /changed under the recovery lock/);
  assert.equal(desktopChecks, 2);
  assert.equal(evidenceLoads, 2);
  assert.equal(recoveryMutations, 0);
  assert.equal(goalRpcFactories, 0);
  assert.equal(goalReconciliations, 0);
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
