#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveClaudeHome, resolveCodexHome } from "./paths.ts";
import {
  inventoryClaudeDesktop,
  resolveClaudeDesktopWorkspace,
  type ClaudeDesktopSourceSession,
} from "./claude-desktop-source.ts";
import { readClaudeJsonl } from "./claude-source.ts";
import { claudeTranscriptToIr } from "./claude-to-ir.ts";
import type { BridgeBundle, BridgeEvent } from "./ir.ts";
import { writeBridgeConversation, defaultBridgeRoot } from "./bridge-store.ts";
import { buildImportPlan, canonicalStringify, type ImportPlan, type ImportPlanSessionSummary } from "./import-plan.ts";
import { selectSessions, type SelectionOptions } from "./selection.ts";
import { loadDesktopSelection } from "./codex-desktop-state.ts";
import { canonicalProjectIdentity } from "./project-identity.ts";
import { findStateDb } from "./codex-db.ts";
import {
  applyCodexTarget,
  acquireCodexTargetLock,
  assertCodexDesktopClosed,
  estimatedActiveTokens,
  inspectCodexTargetPlan,
  operationJournalInputForPlan,
  planCodexTarget,
  releaseCodexTargetLock,
  type CodexTargetLock,
  type CodexTargetPlan,
} from "./codex-target.ts";
import {
  assertOperationJournalReady,
  commitOperationJournalIfPresent,
  loadOperationJournal,
  recoverCreatedFiles,
} from "./operation-journal.ts";
import type { LogicalCodexConversation, LogicalCodexItem } from "./compat/codex/v26_721_41059.ts";
import { assertSupportedCodexTarget, loadInstalledCodexTargetEvidence } from "./version-gate.ts";
import type { CodexTargetEvidence } from "./version-gate.ts";
import { inertHistoricalNotice, parseRenderMode, type RenderMode } from "./render-mode.ts";

export interface MatrixTargetSessionPlan {
  sourceSessionId: string;
  operationId: string;
  threadId: string;
  rolloutPath: string;
  rolloutSha256: string;
  archived: boolean;
  activeTokenUpperBound: number;
}

function releaseTargetLockAfter(
  lock: CodexTargetLock,
  operationFailed: boolean,
  operationError: unknown,
): void {
  try {
    releaseCodexTargetLock(lock);
  } catch (cleanupError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Codex target operation and lock cleanup both failed",
      );
    }
    throw cleanupError;
  }
}

export function formatCliError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors.map((item, index) => {
      const rendered = formatCliError(item).replace(/\n/g, "\n     ");
      return `  ${index + 1}. ${rendered}`;
    });
    return [error.message, ...details].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

export interface MatrixTargetBinding {
  codexHome: string;
  dbPath: string;
  bridgeRoot: string;
  evidence: CodexTargetEvidence;
  sessions: MatrixTargetSessionPlan[];
}

export interface MatrixPlanFile {
  schema: "agentryx.import-plan/v2";
  direction: "claude-to-codex";
  renderMode: RenderMode;
  digest: string;
  plan: ImportPlan;
  target: MatrixTargetBinding;
}

interface LoadedSource {
  desktop: ClaudeDesktopSourceSession;
  bundle: BridgeBundle | null;
  summary: ImportPlanSessionSummary;
}

function optionValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      if (argv[i + 1] == null || argv[i + 1].startsWith("--")) throw new Error(`${name} needs a value`);
      values.push(argv[++i]);
    } else if (argv[i].startsWith(`${name}=`)) {
      values.push(argv[i].slice(name.length + 1));
    }
  }
  return values;
}

function option(argv: string[], name: string): string | undefined {
  const values = optionValues(argv, name);
  return values.at(-1);
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function numberOption(argv: string[], name: string): number | undefined {
  const raw = option(argv, name);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function dateOption(argv: string[], name: string): number | undefined {
  const raw = option(argv, name);
  if (raw == null) return undefined;
  const value = Date.parse(raw);
  if (Number.isNaN(value)) throw new Error(`${name} must be an ISO date/time`);
  return value;
}

export function selectionOptions(argv: string[]): SelectionOptions {
  const archive = option(argv, "--archive") as SelectionOptions["archive"] | undefined;
  if (archive && !["active", "all", "archived"].includes(archive)) {
    throw new Error("--archive must be active, archived, or all");
  }
  const projectScope = option(argv, "--project-scope") as SelectionOptions["projectScope"] | undefined;
  if (projectScope && !["all", "projects", "projectless", "existing-targets"].includes(projectScope)) {
    throw new Error("--project-scope must be all, projects, projectless, or existing-targets");
  }
  const sessionIds = optionValues(argv, "--session");
  const projects = optionValues(argv, "--project");
  return {
    archive,
    projectScope,
    sessionIds: sessionIds.length === 0 ? undefined : sessionIds,
    projects: projects.length === 0 ? undefined : projects,
    fromMs: dateOption(argv, "--from-date"),
    toMs: dateOption(argv, "--to-date"),
    limit: numberOption(argv, "--limit"),
  };
}

function targetProject(codexHome: string, cwd: string): { exists: boolean; name?: string } {
  const state = loadDesktopSelection(codexHome);
  if (!state || cwd === "") return { exists: false };
  const needle = canonicalProjectIdentity(cwd).key;
  let best: { length: number; name: string } | null = null;
  for (const project of state.projects.values()) {
    for (const raw of project.rootPaths) {
      let root: string;
      try { root = canonicalProjectIdentity(raw).key; } catch { continue; }
      if (needle !== root && !needle.startsWith(root + path.sep.toLowerCase())) continue;
      if (best == null || root.length > best.length) best = { length: root.length, name: project.name };
    }
  }
  return best ? { exists: true, name: best.name } : { exists: false };
}

export function transcriptIdentityError(
  desktop: ClaudeDesktopSourceSession,
  transcript: ReturnType<typeof readClaudeJsonl>,
): string | null {
  if (desktop.cliSessionId == null || transcript.sessionIds.length !== 1 ||
    transcript.sessionIds[0] !== desktop.cliSessionId) {
    return "wrapper CLI session id does not match every transcript record";
  }
  if (transcript.cwds.length === 0) return "transcript has no cwd identity";
  let wrapperKey: string;
  try { wrapperKey = canonicalProjectIdentity(desktop.cwd).key; } catch {
    return "wrapper cwd cannot be canonicalized";
  }
  for (const cwd of transcript.cwds) {
    try {
      const transcriptKey = canonicalProjectIdentity(cwd).key;
      const separator = path.sep.toLowerCase();
      const compatible = transcriptKey === wrapperKey ||
        transcriptKey.startsWith(wrapperKey + separator) ||
        wrapperKey.startsWith(transcriptKey + separator);
      if (!compatible) return "wrapper cwd does not match transcript cwd";
    } catch {
      return "transcript cwd cannot be canonicalized";
    }
  }
  return null;
}

function lossObservations(events: BridgeEvent[]): Array<{ kind: string; count: number; detail?: string }> {
  const counts = new Map<string, number>();
  const add = (kind: string): void => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  };
  let compactBoundaries = 0;
  const resultCounts = new Map<string, number>();
  const nativeToolIds = nativeToolUseIds(events);
  for (const event of events) {
    if (event.kind === "tool_result" && event.toolUseId) {
      resultCounts.set(event.toolUseId, (resultCounts.get(event.toolUseId) ?? 0) + 1);
    }
  }
  for (const event of events) {
    if (event.kind === "unknown") add(`sidecar_only:${event.reason}`);
    else if (event.kind === "text" && event.role !== "assistant" && !event.authoredByHuman) {
      add("historical_context_not_activated");
    }
    else if (event.kind === "task_notification") add("historical_task_not_live");
    else if (event.kind === "goal_snapshot") add("historical_goal_not_activated");
    else if (event.kind === "access_snapshot") add("historical_access_not_regranted");
    else if (event.kind === "compact_boundary" && event.activeContextStartsAfter) compactBoundaries += 1;
    if (event.timestamp != null && !Number.isFinite(Date.parse(event.timestamp))) add("invalid_timestamp_replaced");
    if (event.kind === "tool_use") {
      const valid = event.toolUseId != null && nativeToolIds.has(event.toolUseId);
      if (!valid) add("tool_call_demoted_to_inert_text");
      else if ((resultCounts.get(event.toolUseId!) ?? 0) === 0) add("tool_result_synthesized");
    } else if (event.kind === "tool_result") {
      const valid = event.toolUseId != null && nativeToolIds.has(event.toolUseId) && resultCounts.get(event.toolUseId) === 1;
      if (!valid) add("tool_result_demoted_to_inert_text");
      if (event.isError === true) add("tool_result_error_status_sidecar_only");
      if (event.displayResult !== undefined) add("tool_result_display_sidecar_only");
      if (Array.isArray(event.content)) add("tool_result_structured_content_stringified");
      if (Array.isArray(event.content) && event.content.some((block) =>
        block != null && typeof block === "object" && (block as Record<string, unknown>).type === "image")) {
        add("tool_result_image_sidecar_only");
      }
    }
  }
  if (compactBoundaries > 1) counts.set("earlier_compaction_sidecar_only", compactBoundaries - 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => ({ kind, count }));
}

export function nativeToolUseIds(events: BridgeEvent[]): Set<string> {
  const callIndexes = new Map<string, number[]>();
  const resultIndexes = new Map<string, number[]>();
  for (const [index, event] of events.entries()) {
    if (event.kind === "tool_use" && event.toolUseId) {
      const indexes = callIndexes.get(event.toolUseId) ?? [];
      indexes.push(index);
      callIndexes.set(event.toolUseId, indexes);
    } else if (event.kind === "tool_result" && event.toolUseId) {
      const indexes = resultIndexes.get(event.toolUseId) ?? [];
      indexes.push(index);
      resultIndexes.set(event.toolUseId, indexes);
    }
  }
  const valid = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.kind !== "tool_use" || !event.toolUseId || !event.name) continue;
    const plainInput = event.input != null && typeof event.input === "object" && !Array.isArray(event.input);
    const calls = callIndexes.get(event.toolUseId) ?? [];
    const results = resultIndexes.get(event.toolUseId) ?? [];
    if (plainInput && calls.length === 1 && results.length <= 1 && (results.length === 0 || results[0]! > index)) {
      valid.add(event.toolUseId);
    }
  }
  return valid;
}

function loadSources(
  argv: string[], selection: SelectionOptions,
): { sources: LoadedSource[]; workspaceDir: string; unreadable: string[]; inventory: ClaudeDesktopSourceSession[] } {
  const claudeHome = resolveClaudeHome(option(argv, "--claude-home"));
  const codexHome = resolveCodexHome(option(argv, "--codex-home"));
  const sessionsRoot = option(argv, "--sessions-root");
  const workspaceDir = option(argv, "--workspace-dir") ??
    resolveClaudeDesktopWorkspace(claudeHome, sessionsRoot);
  const inventory = inventoryClaudeDesktop(claudeHome, workspaceDir);
  const targets = new Map(inventory.sessions.map((desktop) => [desktop.sessionId, targetProject(codexHome, desktop.cwd)]));
  const selectedIds = new Set(selectSessions(inventory.sessions.map((desktop) => {
    const target = targets.get(desktop.sessionId)!;
    return {
      sessionId: desktop.sessionId,
      cwd: desktop.cwd,
      projectRoot: desktop.cwd,
      projectName: target.name,
      hasProject: desktop.cwd !== "",
      isArchived: desktop.isArchived,
      targetExists: target.exists,
      firstTsMs: desktop.createdAtMs,
      lastTsMs: desktop.lastActivityAtMs,
    };
  }), selection).map((session) => session.sessionId));
  const sources: LoadedSource[] = inventory.sessions.filter((desktop) => selectedIds.has(desktop.sessionId)).map((desktop) => {
    const target = targets.get(desktop.sessionId)!;
    if (!desktop.transcriptExists || desktop.transcriptPath == null) {
      return {
        desktop,
        bundle: null,
        summary: {
          sessionId: desktop.sessionId, cwd: desktop.cwd, projectRoot: desktop.cwd,
          projectName: target.name, hasProject: desktop.cwd !== "", isArchived: desktop.isArchived,
          targetExists: target.exists, firstTsMs: desktop.createdAtMs, lastTsMs: desktop.lastActivityAtMs,
          sourcePath: desktop.transcriptPath ?? undefined, title: desktop.title,
          losses: [{ kind: `transcript_${desktop.transcriptStatus}`, count: 1 }],
        },
      };
    }
    const transcript = readClaudeJsonl(desktop.transcriptPath);
    const identityError = transcriptIdentityError(desktop, transcript);
    if (identityError != null) {
      return {
        desktop,
        bundle: null,
        summary: {
          sessionId: desktop.sessionId, cwd: desktop.cwd, projectRoot: desktop.cwd,
          projectName: target.name, hasProject: desktop.cwd !== "", isArchived: desktop.isArchived,
          targetExists: target.exists, firstTsMs: desktop.createdAtMs, lastTsMs: desktop.lastActivityAtMs,
          sourcePath: desktop.transcriptPath, sourceSha256: transcript.contentSha256,
          title: desktop.title || transcript.title || undefined,
          losses: [{ kind: "transcript_identity_mismatch", count: 1, detail: identityError }],
        },
      };
    }
    const bundle = claudeTranscriptToIr(transcript);
    return {
      desktop,
      bundle,
      summary: {
        sessionId: desktop.sessionId, cwd: desktop.cwd, projectRoot: desktop.cwd,
        projectName: target.name, hasProject: desktop.cwd !== "", isArchived: desktop.isArchived,
        targetExists: target.exists, firstTsMs: desktop.createdAtMs, lastTsMs: desktop.lastActivityAtMs,
        sourcePath: desktop.transcriptPath, sourceSha256: transcript.contentSha256,
        title: desktop.title || transcript.title || undefined,
        messageCount: bundle.conversation.events.filter((event) => event.kind === "text").length,
        losses: lossObservations(bundle.conversation.events),
      },
    };
  });
  return { sources, workspaceDir, unreadable: inventory.unreadableRecords, inventory: inventory.sessions };
}

function compactNumbers(value: unknown): { preTokens?: number; postTokens?: number } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = record.compactMetadata && typeof record.compactMetadata === "object"
    ? record.compactMetadata as Record<string, unknown>
    : record;
  return {
    preTokens: typeof nested.preTokens === "number" ? nested.preTokens : undefined,
    postTokens: typeof nested.postTokens === "number" ? nested.postTokens : undefined,
  };
}

function compactSummary(value: unknown): string | undefined {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const message = record?.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : null;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((block) => block && typeof block === "object" ? (block as Record<string, unknown>).text : null)
    .filter((text): text is string => typeof text === "string")
    .join("\n") || undefined;
}

function tag(text: string, name: string): string | undefined {
  return text.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i"))?.[1]?.trim();
}

function safeTimestamp(value: string | null): string | undefined {
  if (value == null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function inertToolText(label: string, value: unknown): string {
  return `${label}\n${JSON.stringify(value, null, 2) ?? String(value)}`;
}

function exactSourceText(source: LoadedSource): string {
  if (!source.bundle) throw new Error(`source transcript is missing for ${source.desktop.sessionId}`);
  return source.bundle.envelopes.map((envelope) => envelope.raw + envelope.lineEnding).join("");
}

function bridgeToLogical(source: LoadedSource, renderMode: RenderMode): Omit<LogicalCodexConversation, "threadId"> {
  if (!source.bundle) throw new Error(`source transcript is missing for ${source.desktop.sessionId}`);
  if (renderMode === "verbatim") {
    const createdAtMs = source.desktop.createdAtMs;
    const createdAt = createdAtMs != null && Number.isFinite(createdAtMs)
      ? new Date(createdAtMs).toISOString()
      : new Date(0).toISOString();
    const literal = `${inertHistoricalNotice("Claude JSONL")}\n\n${exactSourceText(source)}`;
    const logical = {
      cwd: source.desktop.cwd || os.homedir(),
      title: source.desktop.title || source.bundle.conversation.title || "Imported Claude conversation (verbatim)",
      createdAt,
      messages: [],
      items: [{ kind: "historical_context" as const, text: literal, timestamp: createdAt }],
    };
    estimatedActiveTokens(logical);
    return logical;
  }
  const events = source.bundle.conversation.events;
  const items: LogicalCodexItem[] = [];
  const messages: LogicalCodexConversation["messages"] = [];
  let compaction: LogicalCodexConversation["compaction"];
  let pendingSummary: string | undefined;
  const resultCounts = new Map<string, number>();
  const nativeToolIds = nativeToolUseIds(events);
  for (const event of events) {
    if (event.kind === "tool_result" && event.toolUseId) resultCounts.set(event.toolUseId, (resultCounts.get(event.toolUseId) ?? 0) + 1);
  }
  for (const event of events) {
    if (event.kind === "text") {
      if (event.role !== "assistant" && !event.authoredByHuman) {
        items.push({
          kind: "historical_context",
          text: event.text,
          timestamp: safeTimestamp(event.timestamp),
        });
        continue;
      }
      const role = event.role === "assistant" ? "assistant" : event.role === "system" ? "developer" : "user";
      const message = { role, text: event.text, timestamp: safeTimestamp(event.timestamp) } as const;
      messages.push(message);
      items.push({ kind: "message", ...message });
    } else if (event.kind === "tool_use") {
      const valid = event.toolUseId != null && nativeToolIds.has(event.toolUseId);
      if (!valid) {
        items.push({ kind: "historical_context", text: inertToolText("Imported invalid historical tool call — not executable.", event), timestamp: safeTimestamp(event.timestamp) });
        continue;
      }
      items.push({
        kind: "tool_call", callId: event.toolUseId!, name: event.name!,
        input: event.input, timestamp: safeTimestamp(event.timestamp),
      });
      if ((resultCounts.get(event.toolUseId!) ?? 0) === 0) {
        items.push({
          kind: "tool_result", callId: event.toolUseId!,
          output: "[import] Historical tool call had no recorded result; it was not re-executed.",
          timestamp: safeTimestamp(event.timestamp),
        });
      }
    } else if (event.kind === "tool_result") {
      const valid = event.toolUseId != null && nativeToolIds.has(event.toolUseId) && resultCounts.get(event.toolUseId) === 1;
      if (!valid) {
        items.push({ kind: "historical_context", text: inertToolText("Imported orphan or duplicate historical tool result.", event), timestamp: safeTimestamp(event.timestamp) });
        continue;
      }
      items.push({
        kind: "tool_result", callId: event.toolUseId!, output: event.content,
        timestamp: safeTimestamp(event.timestamp),
      });
    } else if (event.kind === "task_notification") {
      const text = typeof event.content === "string" ? event.content : JSON.stringify(event.content);
      items.push({ kind: "historical_task",
        taskId: event.taskId ?? undefined,
        status: tag(text, "status") ?? "unknown",
        summary: tag(text, "summary"),
        result: tag(text, "result"),
        timestamp: safeTimestamp(event.timestamp),
      });
    } else if (event.kind === "goal_snapshot") {
      items.push({
        kind: "historical_goal",
        goal: event.goal ?? undefined,
        status: event.status ?? undefined,
        timestamp: safeTimestamp(event.timestamp),
      });
    } else if (event.kind === "access_snapshot") {
      items.push({
        kind: "historical_access",
        permissionMode: event.permissionMode ?? undefined,
        timestamp: safeTimestamp(event.timestamp),
      });
    } else if (event.kind === "compact_boundary") {
      if (event.activeContextStartsAfter) {
        compaction = { activeItemIndex: items.length, ...compactNumbers(event.compactMetadata) };
      } else {
        pendingSummary = compactSummary(event.compactMetadata) ?? pendingSummary;
      }
    }
  }
  if (compaction && pendingSummary) compaction.summary = pendingSummary;
  let earliest = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (!event.timestamp) continue;
    const parsed = Date.parse(event.timestamp);
    if (Number.isFinite(parsed) && parsed < earliest) earliest = parsed;
  }
  const createdAt = new Date(source.desktop.createdAtMs ?? earliest);
  const logical = {
    cwd: source.desktop.cwd || os.homedir(),
    title: source.desktop.title || source.bundle.conversation.title || "Imported Claude conversation",
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date(0).toISOString() : createdAt.toISOString(),
    messages,
    items,
    compaction,
  };
  // Force the resume-budget computation during plan/apply mapping.
  estimatedActiveTokens(logical);
  return logical;
}

export function matrixPlanDigest(value: Omit<MatrixPlanFile, "digest">): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

function targetSummary(sourceSessionId: string, plan: CodexTargetPlan): MatrixTargetSessionPlan {
  return {
    sourceSessionId,
    operationId: plan.operationId,
    threadId: plan.threadId,
    rolloutPath: canonicalExistingPath(plan.rolloutPath),
    rolloutSha256: plan.rolloutSha256,
    archived: plan.archived,
    activeTokenUpperBound: estimatedActiveTokens(plan.conversation),
  };
}

function summariesForRenderMode(sources: LoadedSource[], renderMode: RenderMode): ImportPlanSessionSummary[] {
  return sources.map((source): ImportPlanSessionSummary => {
    if (renderMode !== "verbatim" || source.bundle == null) return source.summary;
    return {
      ...source.summary,
      losses: [{
        kind: "verbatim_semantics_intentionally_inert",
        count: Math.max(1, source.bundle.envelopes.length),
        detail: "Canonical source text is preserved, but source-native controls are not activated in the target.",
      }],
    };
  });
}

function buildMatrixPlan(
  sources: LoadedSource[], selection: SelectionOptions, renderMode: RenderMode,
  codexHome: string, dbPath: string, bridgeRoot: string, evidence: CodexTargetEvidence,
): { file: MatrixPlanFile; targetPlans: CodexTargetPlan[] } {
  const summaries = summariesForRenderMode(sources, renderMode);
  const built = buildImportPlan(summaries, { selection });
  const byId = new Map(sources.map((source) => [source.desktop.sessionId, source]));
  const targetPlans = built.plan.sessions.map((selected) => {
    const source = byId.get(selected.sessionId);
    if (!source?.bundle || !selected.sourceSha256) throw new Error(`source is unavailable: ${selected.sessionId}`);
    return planCodexTarget(
      codexHome, dbPath, `${selected.sessionId}\0render:${renderMode}`, selected.sourceSha256,
      bridgeToLogical(source, renderMode), selected.archived,
    );
  });
  const withoutDigest: Omit<MatrixPlanFile, "digest"> = {
    schema: "agentryx.import-plan/v2",
    direction: "claude-to-codex",
    renderMode,
    plan: built.plan,
    target: {
      codexHome: canonicalExistingPath(codexHome),
      dbPath: canonicalExistingPath(dbPath),
      bridgeRoot: canonicalExistingPath(bridgeRoot),
      evidence,
      sessions: targetPlans.map((target, index) => targetSummary(built.plan.sessions[index].sessionId, target)),
    },
  };
  return { file: { ...withoutDigest, digest: matrixPlanDigest(withoutDigest) }, targetPlans };
}

export function selectionFromPlan(plan: ImportPlan): SelectionOptions {
  return {
    archive: plan.selection.archive,
    projectScope: plan.selection.projectScope,
    sessionIds: plan.selection.sessionIds.length === 0 ? undefined : plan.selection.sessionIds,
    projects: plan.selection.projects.length === 0 ? undefined : plan.selection.projects,
    fromMs: plan.selection.fromMs ?? undefined,
    toMs: plan.selection.toMs ?? undefined,
    limit: plan.selection.limit ?? undefined,
  };
}

function writeJson(target: string | undefined, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!target || target === "-") process.stdout.write(text);
  else {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
  }
}

function assertJsonOutputWritable(target: string | undefined): void {
  if (!target || target === "-") return;
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });
  fs.accessSync(fs.existsSync(resolved) ? resolved : parent, fs.constants.W_OK);
}

export const MATRIX_HELP =
  "usage: threadpass <scan|plan|apply|recover> [--archive active|archived|all] " +
  "[--project-scope all|projects|projectless|existing-targets] [--session ID] " +
  "[--project NAME_OR_PATH] [--from-date ISO] [--to-date ISO] [--limit N] " +
  "[--render-mode semantic|verbatim]\n";

export function main(argv = process.argv.slice(2)): void {
  const command = argv[0];
  if (!command) throw new Error(MATRIX_HELP.trimEnd());
  if (command === "help" || flag(argv, "--help")) {
    process.stdout.write(MATRIX_HELP);
    return;
  }
  if (command === "scan") {
    const selection = selectionOptions(argv);
    if (selection.archive == null) selection.archive = "all";
    const loaded = loadSources(argv, selection);
    const renderMode = parseRenderMode(option(argv, "--render-mode"));
    const built = buildImportPlan(summariesForRenderMode(loaded.sources, renderMode), { selection });
    writeJson(option(argv, "--out"), {
      workspaceDir: loaded.workspaceDir,
      inventory: {
        total: loaded.inventory.length,
        selected: loaded.sources.length,
        active: loaded.inventory.filter((source) => !source.isArchived).length,
        archived: loaded.inventory.filter((source) => source.isArchived).length,
        unavailable: loaded.inventory.filter((source) => source.transcriptStatus !== "available").length,
      },
      unreadableRecords: loaded.unreadable,
      renderMode,
      selected: built.plan.sessions,
      losses: built.plan.losses,
      sourceDigest: built.digest,
    });
    return;
  }
  if (command === "plan") {
    const evidencePath = option(argv, "--evidence");
    if (!evidencePath) throw new Error("plan requires --evidence <41059 snapshot manifest>");
    const selection = selectionOptions(argv);
    const loaded = loadSources(argv, selection);
    const codexHome = resolveCodexHome(option(argv, "--codex-home"));
    const dbPath = findStateDb(codexHome);
    if (!dbPath) throw new Error(`no Codex state database found under ${codexHome}`);
    const bridgeRoot = path.resolve(option(argv, "--bridge-root") ?? defaultBridgeRoot());
    const evidence = loadInstalledCodexTargetEvidence(evidencePath);
    const matrix = buildMatrixPlan(
      loaded.sources, selection, parseRenderMode(option(argv, "--render-mode")),
      codexHome, dbPath, bridgeRoot, evidence,
    );
    writeJson(option(argv, "--out"), matrix.file);
    return;
  }
  if (command === "recover") {
    const operationId = option(argv, "--operation");
    const evidencePath = option(argv, "--evidence");
    if (!operationId || !evidencePath) throw new Error("recover requires --operation and --evidence");
    const bridgeRoot = path.resolve(option(argv, "--bridge-root") ?? defaultBridgeRoot());
    const journal = loadOperationJournal(bridgeRoot, operationId);
    const codexHome = resolveCodexHome(option(argv, "--codex-home") ?? journal.targetCodexHome);
    if (canonicalExistingPath(codexHome).toLowerCase() !== canonicalExistingPath(journal.targetCodexHome).toLowerCase()) {
      throw new Error("recovery Codex home does not match the operation journal");
    }
    const evidence = loadInstalledCodexTargetEvidence(evidencePath);
    assertSupportedCodexTarget(evidence);
    assertJsonOutputWritable(option(argv, "--out"));
    const lock = acquireCodexTargetLock(codexHome);
    let operationFailed = false;
    let operationError: unknown;
    try {
      assertCodexDesktopClosed();
      const recovered = recoverCreatedFiles(bridgeRoot, operationId);
      writeJson(option(argv, "--out"), recovered);
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      releaseTargetLockAfter(lock, operationFailed, operationError);
    }
    return;
  }
  if (command !== "apply") throw new Error(MATRIX_HELP.trimEnd());

  const planPath = option(argv, "--plan");
  const evidencePath = option(argv, "--evidence");
  const confirmation = option(argv, "--confirm");
  if (!planPath || !evidencePath || !confirmation) {
    throw new Error("apply requires --plan, --evidence, and --confirm <plan digest>");
  }
  const stored = JSON.parse(fs.readFileSync(planPath, "utf8")) as MatrixPlanFile;
  if (stored.schema !== "agentryx.import-plan/v2" || stored.direction !== "claude-to-codex" ||
    !["semantic", "verbatim"].includes(stored.renderMode)) {
    throw new Error("unsupported import plan");
  }
  const storedContent: Omit<MatrixPlanFile, "digest"> = {
    schema: stored.schema, direction: stored.direction, renderMode: stored.renderMode,
    plan: stored.plan, target: stored.target,
  };
  if (matrixPlanDigest(storedContent) !== stored.digest) {
    throw new Error("stored import plan content does not match its digest");
  }
  if (confirmation !== stored.digest) throw new Error("confirmation digest does not match the plan");
  const requestedMode = option(argv, "--render-mode");
  if (requestedMode != null && parseRenderMode(requestedMode) !== stored.renderMode) {
    throw new Error("apply render mode differs from the confirmed plan");
  }
  const loaded = loadSources(argv, selectionFromPlan(stored.plan));
  const codexHome = resolveCodexHome(option(argv, "--codex-home"));
  const dbPath = findStateDb(codexHome);
  if (!dbPath) throw new Error(`no Codex state database found under ${codexHome}`);
  const evidence = loadInstalledCodexTargetEvidence(evidencePath);
  const bridgeRoot = path.resolve(option(argv, "--bridge-root") ?? defaultBridgeRoot());
  const rebuilt = buildMatrixPlan(
    loaded.sources, selectionFromPlan(stored.plan), stored.renderMode,
    codexHome, dbPath, bridgeRoot, evidence,
  );
  if (rebuilt.file.digest !== stored.digest) {
    throw new Error("source inventory, render mode, or target binding changed after the plan was created");
  }
  const byId = new Map(loaded.sources.map((source) => [source.desktop.sessionId, source]));
  const operations: Array<{ sessionId: string; operationId: string; threadId: string; status: "applied" | "already-applied" }> = [];
  assertJsonOutputWritable(option(argv, "--out"));
  const lock = acquireCodexTargetLock(codexHome);
  let operationFailed = false;
  let operationError: unknown;
  try {
    assertCodexDesktopClosed();
    const states = rebuilt.targetPlans.map(inspectCodexTargetPlan);
    const collision = states.findIndex((state) => state === "collision");
    if (collision >= 0) {
      throw new Error(`target collision for ${stored.plan.sessions[collision].sessionId}; no sessions were written`);
    }
    for (let index = 0; index < rebuilt.targetPlans.length; index += 1) {
      const journalInput = operationJournalInputForPlan(rebuilt.targetPlans[index]);
      if (states[index] === "already-applied") {
        commitOperationJournalIfPresent(bridgeRoot, journalInput);
        continue;
      }
      assertOperationJournalReady(bridgeRoot, journalInput);
    }
    // Preserve every canonical source revision before the first target mutation.
    for (const selected of stored.plan.sessions) {
      const source = byId.get(selected.sessionId);
      if (!source?.bundle) throw new Error(`source is unavailable: ${selected.sessionId}`);
      writeBridgeConversation(bridgeRoot, source.bundle);
    }
    for (let index = 0; index < rebuilt.targetPlans.length; index += 1) {
      const targetPlan = rebuilt.targetPlans[index];
      const selected = stored.plan.sessions[index];
      if (states[index] === "already-applied") {
        operations.push({ sessionId: selected.sessionId, operationId: targetPlan.operationId, threadId: targetPlan.threadId, status: "already-applied" });
        continue;
      }
      const operation = applyCodexTarget(targetPlan, {
        allowWrite: true, evidence, bridgeRoot, lock,
      });
      operations.push({ sessionId: selected.sessionId, operationId: operation.operationId, threadId: targetPlan.threadId, status: "applied" });
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    releaseTargetLockAfter(lock, operationFailed, operationError);
  }
  writeJson(option(argv, "--out"), {
    renderMode: stored.renderMode,
    applied: operations.filter((operation) => operation.status === "applied").length,
    alreadyApplied: operations.filter((operation) => operation.status === "already-applied").length,
    operations,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(formatCliError(error));
    process.exitCode = 1;
  }
}
