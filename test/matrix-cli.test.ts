import test from "node:test";
import assert from "node:assert/strict";

import {
  matrixPlanDigest,
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
  const base: Omit<MatrixPlanFile, "digest"> = {
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
