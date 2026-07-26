import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { BridgeBundle, BridgeEvent } from "./ir.ts";
import type { GoalMigrationMode } from "./goal.ts";
import { applyClaudeGoalTarget } from "./claude-goal-target.ts";
import { inertHistoricalNotice, type RenderMode } from "./render-mode.ts";
import { splitCitations } from "./citation.ts";
import { splitUserMessage } from "./preamble.ts";
import { validateTranscript } from "./validate.ts";
import { DEFAULT_MAX_TRANSCRIPT_CHARS } from "./repair.ts";
import { serializeLines, sha256File, sha256Text } from "./claude-target.ts";
import { buildWrapperRecord, type WrapperRecord } from "./claude-desktop-target.ts";
import type { AnthropicBlock, ClaudeTranscriptLine, ClaudeTranscriptRecord, CodexSession } from "./types.ts";

export const CLAUDE_FORWARD_RENDERER_ID = "claude.typed-history-renderer/v1" as const;
export const CLAUDE_FORWARD_RENDERER_FINGERPRINT = createHash("sha256").update(
  "pass-the-thread:claude.typed-history-renderer/v1:semantic-verbatim:goal-v1:deterministic-uuid:sidecar-controls",
).digest("hex");

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function uuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function iso(event: BridgeEvent, session: CodexSession): string {
  const parsed = event.timestamp == null ? Number.NaN : Date.parse(event.timestamp);
  return new Date(Number.isFinite(parsed) ? parsed : session.firstTsMs ?? session.lastTsMs ?? 0).toISOString();
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return text(record.text ?? record.summary_text ?? record.content ?? "");
  }
  return "";
}

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  const rendered = JSON.stringify(value);
  return rendered ?? String(value ?? "");
}

function toolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return value == null || value === "" ? {} : { input: value };
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function imageBlock(event: Extract<BridgeEvent, { kind: "media" }>): AnthropicBlock | null {
  if (event.mediaType !== "image" || typeof event.source !== "string") return null;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(event.source);
  if (!match || !IMAGE_TYPES.has(match[1]!.toLowerCase()) || !validBase64(match[2]!)) return null;
  return { type: "image", source: { type: "base64", media_type: match[1]!.toLowerCase(), data: match[2]! } };
}

export function isRenderableForwardImage(event: Extract<BridgeEvent, { kind: "media" }>): boolean {
  return imageBlock(event) != null;
}

function notificationText(event: Extract<BridgeEvent, { kind: "task_notification" }>): string {
  const structured = event.content && typeof event.content === "object" && !Array.isArray(event.content)
    ? event.content as Record<string, unknown> : null;
  const raw = typeof event.content === "string" ? event.content
    : typeof structured?.message === "string" ? structured.message
      : typeof structured?.content === "string" ? structured.content : "";
  const field = (name: string): string | null => raw.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i"))?.[1]?.trim() ?? null;
  const known = (name: string): string | null => field(name) ??
    (typeof structured?.[name] === "string" ? structured[name] as string : null);
  const parts = [
    `[pass-the-thread] Historical task notification${event.taskId ? ` ${event.taskId}` : ""} (not resumed).`,
    known("status") ? `Status: ${known("status")}` : null,
    known("summary") ? `Summary: ${known("summary")}` : null,
    known("result") ? `Result: ${known("result")}` : null,
    known("note") ? `Note: ${known("note")}` : null,
  ].filter((part): part is string => part != null);
  return parts.join("\n");
}

export interface RenderForwardOptions {
  renderMode: RenderMode;
  goalMode: GoalMigrationMode;
}

/** Deterministically render typed historical IR; unsupported controls remain only in the lossless sidecar. */
export function renderForwardClaudeTranscript(
  session: CodexSession,
  bundle: BridgeBundle,
  options: RenderForwardOptions,
): ClaudeTranscriptRecord[] {
  if (bundle.conversation.sourceContentSha256 !== session.sourceContentSha256 && session.sourceContentSha256 != null) {
    throw new Error(`typed source hash mismatch for ${session.sessionId}`);
  }
  const gitBranch = session.meta.git?.branch;
  let parentUuid: string | null = null;
  let sequence = 0;
  const lines: ClaudeTranscriptLine[] = [];
  const emit = (
    type: "user" | "assistant",
    blocks: AnthropicBlock[],
    event: BridgeEvent,
    meta = false,
  ): void => {
    if (blocks.length === 0) return;
    const recordUuid = uuid(`${bundle.conversation.sourceContentSha256}:${event.id}:${sequence++}`);
    const line: ClaudeTranscriptLine = {
      parentUuid, isSidechain: false, userType: "external", cwd: session.cwd,
      sessionId: session.sessionId, version: "0.0.0-pass-the-thread", type,
      message: type === "assistant"
        ? { role: "assistant", content: blocks, ...(session.model ? { model: session.model } : {}) }
        : { role: "user", content: blocks },
      uuid: recordUuid, timestamp: iso(event, session), ...(meta ? { isMeta: true } : {}),
    };
    if (gitBranch) line.gitBranch = gitBranch;
    lines.push(line);
    parentUuid = recordUuid;
  };

  if (options.renderMode === "verbatim") {
    const literal = bundle.envelopes.map((envelope) => envelope.raw + envelope.lineEnding).join("");
    if (literal !== "") {
      const event = bundle.conversation.events[0] ?? ({
        id: "verbatim", timestamp: null,
      } as BridgeEvent);
      emit("user", [
        { type: "text", text: inertHistoricalNotice("Codex rollout JSONL") },
        { type: "text", text: literal },
      ], event, true);
    }
  } else {
    const events = bundle.conversation.events;
    const lastPortableBoundaryIndex = events.findLastIndex((candidate) =>
      candidate.kind === "compact_boundary" && candidate.activeContextStartsAfter);
    const activeEvents = lastPortableBoundaryIndex < 0 ? events : events.slice(lastPortableBoundaryIndex);
    const validToolUses = new Set<string>();
    const calls = new Map<string, number>();
    const results = new Map<string, number>();
    for (const event of activeEvents) {
      if (event.kind === "tool_use" && event.toolUseId) calls.set(event.toolUseId, (calls.get(event.toolUseId) ?? 0) + 1);
      if (event.kind === "tool_result" && event.toolUseId) results.set(event.toolUseId, (results.get(event.toolUseId) ?? 0) + 1);
    }
    for (const [index, event] of activeEvents.entries()) {
      const resultIndex = event.kind === "tool_use" && event.toolUseId
        ? activeEvents.findIndex((candidate) => candidate.kind === "tool_result" && candidate.toolUseId === event.toolUseId)
        : -1;
      const plainInput = event.kind === "tool_use" && event.input != null && typeof event.input === "object" && !Array.isArray(event.input);
      if (event.kind === "tool_use" && event.toolUseId && event.name && plainInput && calls.get(event.toolUseId) === 1 &&
        (results.get(event.toolUseId) ?? 0) <= 1 && (resultIndex < 0 || resultIndex > index)) {
        validToolUses.add(event.id);
      }
    }
    const handledResults = new Set<string>();
    const earlierCompactEnvelopeIds = new Set(events
      .filter((event, index) => event.kind === "compact_boundary" && event.activeContextStartsAfter &&
        index !== lastPortableBoundaryIndex)
      .map((event) => event.sourceEnvelopeId));
    if (lastPortableBoundaryIndex >= 0) {
      assertPortableCompactReplacement(events, lastPortableBoundaryIndex, validToolUses, session.sessionId);
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (earlierCompactEnvelopeIds.has(event.sourceEnvelopeId)) continue;
      if (event.kind === "text") {
        if (event.role === "assistant") {
          const citation = splitCitations(event.text);
          if (citation.body !== "") emit("assistant", [{ type: "text", text: citation.body }], event);
          for (const item of citation.citations) emit("user", [{ type: "text", text: item }], event, true);
        } else {
          const split = splitUserMessage(event.authoredByHuman ? "user" : event.role, event.text);
          if (split.meta) emit("user", [{ type: "text", text: split.meta }], event, true);
          if (split.request) emit("user", [{ type: "text", text: split.request }], event, !event.authoredByHuman);
        }
      } else if (event.kind === "reasoning") {
        const thinking = [text(event.summary), text(event.content)].filter(Boolean).join("\n\n");
        if (thinking) emit("user", [{ type: "text", text: `[pass-the-thread] Historical Codex reasoning (not a signed Claude thinking block):\n${thinking}` }], event, true);
      } else if (event.kind === "tool_use" && event.toolUseId && validToolUses.has(event.id)) {
        const resultIndex = events.findIndex((candidate, candidateIndex) => candidateIndex > index &&
          candidate.kind === "tool_result" && candidate.toolUseId === event.toolUseId);
        const result = resultIndex >= 0 ? events[resultIndex] as Extract<BridgeEvent, { kind: "tool_result" }> : null;
        emit("assistant", [{ type: "tool_use", id: event.toolUseId, name: event.name!, input: toolInput(event.input) }], event);
        emit("user", [{ type: "tool_result", tool_use_id: event.toolUseId,
          content: result == null ? "[pass-the-thread] Historical tool call had no recorded result; it was not re-executed." : toolOutput(result.content),
          ...(result?.isError === true ? { is_error: true } : {}),
        }], result ?? event);
        if (result != null) handledResults.add(result.id);
      } else if (event.kind === "tool_use") {
        emit("user", [{ type: "text", text: "[pass-the-thread] An invalid historical tool call is preserved in the canonical sidecar and was not made executable." }], event, true);
      } else if (event.kind === "tool_result" && !handledResults.has(event.id)) {
        emit("user", [{ type: "text", text: "[pass-the-thread] An orphan or duplicate historical tool result is preserved in the canonical sidecar." }], event, true);
      } else if (event.kind === "task_notification") {
        emit("user", [{ type: "text", text: notificationText(event) }], event, true);
      } else if (event.kind === "media") {
        const image = imageBlock(event);
        if (image) {
          emit("user", [image], event, !event.authoredByHuman);
        }
      } else if (event.kind === "compact_boundary" && event.activeContextStartsAfter) {
        if (index !== lastPortableBoundaryIndex) continue;
        const recordUuid = uuid(`${bundle.conversation.sourceContentSha256}:${event.id}:${sequence++}`);
        const line: ClaudeTranscriptLine = {
          parentUuid, isSidechain: false, userType: "external", cwd: session.cwd,
          sessionId: session.sessionId, version: "0.0.0-pass-the-thread", type: "system",
          subtype: "compact_boundary", compactMetadata: {}, message: { role: "user", content: [] },
          uuid: recordUuid, timestamp: iso(event, session),
        };
        if (gitBranch) line.gitBranch = gitBranch;
        lines.push(line); parentUuid = recordUuid;
      }
      // goal/access/protocol/turn_context/world_state/unknown stay typed in the canonical sidecar.
    }
  }
  if (lines.length === 0) {
    const event = bundle.conversation.events[0] ?? ({ id: "empty", timestamp: null } as BridgeEvent);
    emit("user", [{ type: "text", text: "[pass-the-thread] This source has no safely renderable chat events. Its exact typed history is preserved in the canonical sidecar; none was activated as chat." }], event, true);
  }
  if (lines.length > 0) {
    lines[0]!.customTitle = (session.codexName || session.title || session.sessionId).slice(0, 200);
  }
  const composed = applyClaudeGoalTarget(session, lines, bundle.conversation.goalState, options.goalMode);
  const issues = validateTranscript(composed);
  if (issues.length > 0) throw new Error(`typed Claude render is not replayable for ${session.sessionId}: ${issues[0]!.kind} @line ${issues[0]!.line}`);
  const lastBoundary = composed.findLastIndex((line) => line.type === "system" && line.subtype === "compact_boundary");
  const activeChars = composed.slice(lastBoundary + 1).reduce((sum, line) => sum + JSON.stringify(line).length + 1, 0);
  if (activeChars > DEFAULT_MAX_TRANSCRIPT_CHARS) {
    throw new Error(
      `typed Claude render active context for ${session.sessionId} is ${activeChars} characters; ` +
      `maximum is ${DEFAULT_MAX_TRANSCRIPT_CHARS}. The canonical sidecar remains lossless; no target was written`,
    );
  }
  return composed;
}

function assertPortableCompactReplacement(
  events: readonly BridgeEvent[],
  boundaryIndex: number,
  validToolUses: ReadonlySet<string>,
  sessionId: string,
): void {
  const boundary = events[boundaryIndex]!;
  const replacement: BridgeEvent[] = [];
  for (let index = boundaryIndex + 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sourceEnvelopeId !== boundary.sourceEnvelopeId) break;
    replacement.push(event);
  }
  if (replacement.some((event) => event.kind === "unknown")) {
    throw new Error(`Codex compact replacement contains unknown or malformed content: ${sessionId}`);
  }
  const portableCount = replacement.filter((event) => {
    if (event.kind === "text") return event.text.trim() !== "";
    if (event.kind === "reasoning") return [text(event.summary), text(event.content)].join("\n").trim() !== "";
    if (event.kind === "task_notification") return notificationText(event).trim() !== "";
    if (event.kind === "media") return imageBlock(event) != null;
    if (event.kind === "tool_use") return event.toolUseId != null && validToolUses.has(event.id);
    return false;
  }).length;
  if (portableCount === 0) {
    throw new Error(`Codex compact boundary has no safely renderable replacement content: ${sessionId}`);
  }
}

export interface ForwardAssetPlan {
  path: string;
  beforeSha256: string | null;
  afterSha256: string;
  afterContents: string;
}

export interface ForwardSessionApplyPlan {
  sessionId: string;
  operationId: string;
  sourceSha256: string;
  transcript: ForwardAssetPlan;
  wrapper: ForwardAssetPlan | null;
}

export interface ForwardApplyJournal {
  schema: "agentryx.forward-operation/v1";
  operationId: string;
  planDigest: string;
  rendererId: typeof CLAUDE_FORWARD_RENDERER_ID;
  rendererFingerprint: string;
  claudeHome: string;
  workspaceDir: string | null;
  state: "prepared" | "applying" | "committed" | "rolled-back" | "reconciliation-required";
  createdAt: string;
  updatedAt: string;
  sessions: ForwardSessionApplyPlan[];
}

function currentSha(filePath: string): string | null {
  return fs.existsSync(filePath) ? sha256File(filePath) : null;
}

function fsyncWritableFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Directory fsync is unavailable on some Windows filesystems; use it everywhere the runtime supports it. */
function fsyncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) throw error;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function ensureDirectory(directory: string): void {
  const parent = path.dirname(directory);
  fs.mkdirSync(directory, { recursive: true });
  fsyncDirectory(directory);
  if (parent !== directory && fs.existsSync(parent)) fsyncDirectory(parent);
}

function writeNewDurable(filePath: string, contents: string | Buffer): void {
  const fd = fs.openSync(filePath, "wx");
  try {
    fs.writeFileSync(fd, contents, typeof contents === "string" ? { encoding: "utf8" } : undefined);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(filePath));
}

function durableRename(from: string, to: string): void {
  fs.renameSync(from, to);
  fsyncDirectory(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) fsyncDirectory(path.dirname(from));
}

/** Publish an importer-created writable inode and flush its new directory identity on Windows. */
function durableWritableRename(from: string, to: string): void {
  fs.renameSync(from, to);
  fsyncWritableFile(to);
  fsyncDirectory(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) fsyncDirectory(path.dirname(from));
}

function durableLink(from: string, to: string): void {
  fs.linkSync(from, to);
  // Every link source is an importer-created, already-fsynced stage/restore-stage.
  fsyncWritableFile(to);
  fsyncDirectory(path.dirname(to));
}

function durableRemove(filePath: string): void {
  try { fs.rmSync(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    // Windows refuses unlinking a read-only plan-time swap even after the replacement is committed.
    fs.chmodSync(filePath, 0o600);
    fs.rmSync(filePath);
  }
  fsyncDirectory(path.dirname(filePath));
}

function atomicWrite(filePath: string, contents: string): void {
  ensureDirectory(path.dirname(filePath));
  const expectedSha = sha256Text(contents);
  const stage = path.join(path.dirname(filePath), `.${path.basename(filePath)}.pass-the-thread.stage`);
  try {
    try { writeNewDurable(stage, contents); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = fs.lstatSync(stage);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe operation stage collision at ${stage}`);
      if (sha256File(stage) !== expectedSha) {
        durableRemove(stage);
        writeNewDurable(stage, contents);
      }
    }
    durableWritableRename(stage, filePath);
  } finally {
    try { fs.rmSync(stage, { force: true }); } catch { /* best effort stage cleanup */ }
  }
}

function journalPath(bridgeRoot: string, operationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new Error("invalid forward operation id");
  }
  return path.join(bridgeRoot, "forward-operations", `${operationId}.json`);
}

function backupPath(bridgeRoot: string, operationId: string, asset: ForwardAssetPlan): string | null {
  if (asset.beforeSha256 == null) return null;
  return path.join(bridgeRoot, "forward-backups", operationId, `${asset.beforeSha256}.bin`);
}

function allAssets(plan: readonly ForwardSessionApplyPlan[]): ForwardAssetPlan[] {
  return plan.flatMap((session) => session.wrapper == null ? [session.transcript] : [session.transcript, session.wrapper]);
}

function isStrictlyInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoSymlinkComponents(candidate: string): void {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`forward target path contains a symbolic link or junction: ${current}`);
  }
}

function assertForwardPaths(
  sessions: readonly ForwardSessionApplyPlan[],
  claudeHome: string,
  workspaceDir: string | null,
): void {
  for (const session of sessions) {
    if (!isStrictlyInside(session.transcript.path, path.join(claudeHome, "projects"))) {
      throw new Error(`forward transcript escapes Claude projects: ${session.transcript.path}`);
    }
    assertNoSymlinkComponents(session.transcript.path);
    if (session.wrapper != null && (workspaceDir == null || !isStrictlyInside(session.wrapper.path, workspaceDir))) {
      throw new Error(`forward wrapper escapes Claude workspace: ${session.wrapper.path}`);
    }
    if (session.wrapper != null) assertNoSymlinkComponents(session.wrapper.path);
  }
}

type AssetState = "before" | "before-moved" | "before-restored" | "after" | "after-moved" | "created-moved";

function assetStagePath(asset: ForwardAssetPlan): string {
  return path.join(path.dirname(asset.path), `.${path.basename(asset.path)}.pass-the-thread.stage`);
}

function assetSwapPath(asset: ForwardAssetPlan): string {
  return path.join(path.dirname(asset.path), `.${path.basename(asset.path)}.pass-the-thread.swap`);
}

function assetRestoreStagePath(asset: ForwardAssetPlan): string {
  return path.join(path.dirname(asset.path), `.${path.basename(asset.path)}.pass-the-thread.restore-stage`);
}

function assertPathState(asset: ForwardAssetPlan): AssetState {
  const actual = currentSha(asset.path);
  const swap = assetSwapPath(asset);
  const swapSha = currentSha(swap);
  if (actual === asset.afterSha256) {
    if (swapSha != null && swapSha !== asset.beforeSha256) throw new Error(`target swap collision at ${swap}`);
    return "after";
  }
  if (actual === asset.beforeSha256) {
    if (swapSha === asset.afterSha256) {
      const restoreSha = currentSha(assetRestoreStagePath(asset));
      if (restoreSha == null || restoreSha === asset.beforeSha256) return "before-restored";
      throw new Error(`restore stage collision at ${assetRestoreStagePath(asset)}`);
    }
    if (swapSha != null) throw new Error(`unexpected target swap at ${swap}`);
    return "before";
  }
  if (actual == null && asset.beforeSha256 != null && swapSha === asset.beforeSha256) return "before-moved";
  if (actual == null && asset.beforeSha256 != null && swapSha === asset.afterSha256 &&
    currentSha(assetRestoreStagePath(asset)) === asset.beforeSha256) return "after-moved";
  if (actual == null && asset.beforeSha256 == null && swapSha === asset.afterSha256) return "created-moved";
  throw new Error(`target drift or collision at ${asset.path}`);
}

function ensureAssetStage(asset: ForwardAssetPlan, guard: () => void): string {
  const stage = assetStagePath(asset);
  ensureDirectory(path.dirname(asset.path));
  guard();
  try { writeNewDurable(stage, asset.afterContents); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(stage);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256File(stage) !== asset.afterSha256) {
      throw new Error(`unsafe target stage collision at ${stage}`);
    }
  }
  if (sha256File(stage) !== asset.afterSha256) throw new Error(`target stage readback mismatch at ${stage}`);
  guard();
  return stage;
}

/** Publish with a no-overwrite link for creates and a checked move-aside for replacements. */
function publishAsset(asset: ForwardAssetPlan, guard: () => void, afterMove?: () => void): void {
  guard();
  let state = assertPathState(asset);
  if (state === "after") {
    return;
  }
  const stage = ensureAssetStage(asset, guard);
  if (asset.beforeSha256 == null) {
    guard();
    try { durableLink(stage, asset.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || currentSha(asset.path) !== asset.afterSha256) throw error;
    }
    if (currentSha(asset.path) !== asset.afterSha256) throw new Error(`target readback mismatch at ${asset.path}`);
    durableRemove(stage);
    guard();
    return;
  }
  const swap = assetSwapPath(asset);
  if (state === "before") {
    if (fs.existsSync(swap)) throw new Error(`target swap collision at ${swap}`);
    guard();
    durableRename(asset.path, swap);
    if (currentSha(swap) !== asset.beforeSha256) {
      if (!fs.existsSync(asset.path)) fs.renameSync(swap, asset.path);
      throw new Error(`target changed during checked replacement: ${asset.path}`);
    }
    state = "before-moved";
    afterMove?.();
  }
  if (state !== "before-moved" || currentSha(swap) !== asset.beforeSha256 || fs.existsSync(asset.path)) {
    throw new Error(`cannot reconcile checked replacement at ${asset.path}`);
  }
  guard();
  try { durableLink(stage, asset.path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || currentSha(asset.path) !== asset.afterSha256) throw error;
  }
  if (currentSha(asset.path) !== asset.afterSha256) throw new Error(`target readback mismatch at ${asset.path}`);
  durableRemove(stage);
  guard();
  // Keep the plan-time swap until the committed journal transition is durable.
}

function restoreAssetBytes(
  asset: ForwardAssetPlan,
  backup: string,
  afterLink?: () => void,
  afterStageDelete?: () => void,
): void {
  const bytes = fs.readFileSync(backup);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.beforeSha256) {
    throw new Error(`missing or invalid immutable backup ${backup}`);
  }
  const restoreStage = assetRestoreStagePath(asset);
  try {
    writeNewDurable(restoreStage, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(restoreStage);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256File(restoreStage) !== asset.beforeSha256) {
      throw new Error(`unsafe restore stage collision at ${restoreStage}`);
    }
  }
  const swap = assetSwapPath(asset);
  if (fs.existsSync(swap)) throw new Error(`target swap collision at ${swap}`);
  durableRename(asset.path, swap);
  if (sha256File(swap) !== asset.afterSha256) {
    if (!fs.existsSync(asset.path)) fs.renameSync(swap, asset.path);
    throw new Error(`target changed during rollback: ${asset.path}`);
  }
  durableLink(restoreStage, asset.path);
  if (sha256File(asset.path) !== asset.beforeSha256) throw new Error(`rollback readback mismatch at ${asset.path}`);
  afterLink?.();
  durableRemove(restoreStage);
  afterStageDelete?.();
  durableRemove(swap);
}

function writeJournal(bridgeRoot: string, journal: ForwardApplyJournal): void {
  atomicWrite(journalPath(bridgeRoot, journal.operationId), `${JSON.stringify(journal, null, 2)}\n`);
}

export function loadForwardApplyJournal(bridgeRoot: string, operationId: string): ForwardApplyJournal {
  const journal = JSON.parse(fs.readFileSync(journalPath(bridgeRoot, operationId), "utf8")) as ForwardApplyJournal;
  if (journal?.schema !== "agentryx.forward-operation/v1" || journal.operationId !== operationId ||
    !Array.isArray(journal.sessions) || !/^[0-9a-f]{64}$/.test(journal.planDigest) ||
    typeof journal.claudeHome !== "string" ||
    (journal.workspaceDir !== null && typeof journal.workspaceDir !== "string")) {
    throw new Error(`invalid forward operation journal ${operationId}`);
  }
  assertForwardPaths(journal.sessions, journal.claudeHome, journal.workspaceDir);
  return journal;
}

function ensureBackups(bridgeRoot: string, operationId: string, sessions: readonly ForwardSessionApplyPlan[]): void {
  for (const asset of allAssets(sessions)) {
    const state = assertPathState(asset);
    if (state === "after-moved" || state === "before-restored" || state === "created-moved") {
      throw new Error(`rollback is incomplete at ${asset.path}; run recover again`);
    }
    const out = backupPath(bridgeRoot, operationId, asset);
    if (state === "after") {
      if (out != null && asset.beforeSha256 !== asset.afterSha256 &&
        (!fs.existsSync(out) || sha256File(out) !== asset.beforeSha256)) {
        throw new Error(`missing pre-mutation backup ${out}`);
      }
      continue;
    }
    if (out == null) continue;
    if (state === "before-moved") {
      if (!fs.existsSync(out) || sha256File(out) !== asset.beforeSha256) throw new Error(`missing pre-mutation backup ${out}`);
      continue;
    }
    const bytes = fs.readFileSync(asset.path);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.beforeSha256) throw new Error(`backup source drift at ${asset.path}`);
    ensureDirectory(path.dirname(out));
    try { writeNewDurable(out, bytes); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (sha256File(out) !== asset.beforeSha256) throw new Error(`immutable backup collision at ${out}`);
  }
}

function cleanupCommittedAssets(sessions: readonly ForwardSessionApplyPlan[]): void {
  for (const asset of allAssets(sessions)) {
    if (assertPathState(asset) !== "after") throw new Error(`committed target drift at ${asset.path}`);
    const stage = assetStagePath(asset);
    if (fs.existsSync(stage)) {
      if (sha256File(stage) !== asset.afterSha256) throw new Error(`unexpected committed stage collision at ${stage}`);
      durableRemove(stage);
    }
    const swap = assetSwapPath(asset);
    if (fs.existsSync(swap)) {
      if (asset.beforeSha256 == null || sha256File(swap) !== asset.beforeSha256) {
        throw new Error(`unexpected committed swap collision at ${swap}`);
      }
      durableRemove(swap);
    }
  }
}

function finishCommittedCleanup(
  bridgeRoot: string,
  journal: ForwardApplyJournal,
  afterCommittedJournal?: () => void,
): ForwardApplyJournal {
  try {
    afterCommittedJournal?.();
    cleanupCommittedAssets(journal.sessions);
    return journal;
  } catch (error) {
    const reconciliation: ForwardApplyJournal = {
      ...journal,
      state: "reconciliation-required",
      updatedAt: new Date().toISOString(),
    };
    writeJournal(bridgeRoot, reconciliation);
    throw new AggregateError(
      [error],
      `forward operation ${journal.operationId} committed but cleanup requires reconciliation; ` +
      `external target bytes were preserved`,
    );
  }
}

export interface ApplyForwardOptions {
  bridgeRoot: string;
  claudeHome: string;
  workspaceDir: string | null;
  planDigest: string;
  allowOverwrite: boolean;
  failureAfterWrites?: number;
  failureAfterMoves?: number;
  afterCommittedJournal?: () => void;
}

/** Apply or resume a forward batch. Existing assets require explicit authorization and exact plan-time hashes. */
export function applyForwardSessions(
  sessions: readonly ForwardSessionApplyPlan[],
  options: ApplyForwardOptions,
): ForwardApplyJournal {
  const operationId = uuid(`forward:${options.planDigest}`);
  assertForwardPaths(sessions, options.claudeHome, options.workspaceDir);
  for (const asset of allAssets(sessions)) {
    const state = assertPathState(asset);
    if (state !== "after" && asset.beforeSha256 != null && !options.allowOverwrite) {
      throw new Error(`existing target requires --allow-overwrite: ${asset.path}`);
    }
  }
  let journal: ForwardApplyJournal;
  try {
    journal = loadForwardApplyJournal(options.bridgeRoot, operationId);
    if (journal.planDigest !== options.planDigest || journal.rendererFingerprint !== CLAUDE_FORWARD_RENDERER_FINGERPRINT ||
      path.resolve(journal.claudeHome) !== path.resolve(options.claudeHome) ||
      (journal.workspaceDir == null ? null : path.resolve(journal.workspaceDir)) !==
        (options.workspaceDir == null ? null : path.resolve(options.workspaceDir)) ||
      JSON.stringify(journal.sessions) !== JSON.stringify(sessions)) throw new Error("forward operation journal binding mismatch");
    if (journal.state === "committed") {
      return finishCommittedCleanup(options.bridgeRoot, journal, options.afterCommittedJournal);
    }
    if (journal.state === "reconciliation-required") {
      throw new Error(`forward operation ${operationId} requires reconciliation; run recover`);
    }
    if (journal.state === "rolled-back") {
      journal = { ...journal, state: "prepared", updatedAt: new Date().toISOString() };
      writeJournal(options.bridgeRoot, journal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const now = new Date().toISOString();
    journal = {
      schema: "agentryx.forward-operation/v1", operationId, planDigest: options.planDigest,
      rendererId: CLAUDE_FORWARD_RENDERER_ID, rendererFingerprint: CLAUDE_FORWARD_RENDERER_FINGERPRINT,
      claudeHome: path.resolve(options.claudeHome),
      workspaceDir: options.workspaceDir == null ? null : path.resolve(options.workspaceDir),
      state: "prepared", createdAt: now, updatedAt: now, sessions: [...sessions],
    };
    writeJournal(options.bridgeRoot, journal);
  }
  ensureBackups(options.bridgeRoot, operationId, sessions);
  journal = { ...journal, state: "applying", updatedAt: new Date().toISOString() };
  writeJournal(options.bridgeRoot, journal);
  let writes = 0;
  let moves = 0;
  const guard = (): void => assertForwardPaths(sessions, options.claudeHome, options.workspaceDir);
  for (const asset of allAssets(sessions)) {
    if (assertPathState(asset) === "after") continue;
    publishAsset(asset, guard, () => {
      moves += 1;
      if (options.failureAfterMoves === moves) throw new Error("injected forward move failure");
    });
    writes += 1;
    if (currentSha(asset.path) !== asset.afterSha256) throw new Error(`target readback mismatch at ${asset.path}`);
    if (options.failureAfterWrites === writes) throw new Error("injected forward apply failure");
  }
  journal = { ...journal, state: "committed", updatedAt: new Date().toISOString() };
  writeJournal(options.bridgeRoot, journal);
  return finishCommittedCleanup(options.bridgeRoot, journal, options.afterCommittedJournal);
}

/** Restore every asset to its plan-time bytes, or remove importer-created assets. */
export function rollbackForwardSessions(
  bridgeRoot: string,
  operationId: string,
  failure?: {
    afterRestoreLinks?: number;
    afterRestoreStageDeletes?: number;
    afterRemovalMoves?: number;
    beforeRemovalMove?: () => void;
  },
): ForwardApplyJournal {
  let journal = loadForwardApplyJournal(bridgeRoot, operationId);
  if (journal.state === "reconciliation-required") return journal;
  if (journal.state === "committed") throw new Error("committed operations require explicit reverse migration");
  let restoreLinks = 0;
  let restoreStageDeletes = 0;
  let removalMoves = 0;
  for (const asset of [...allAssets(journal.sessions)].reverse()) {
    const state = assertPathState(asset);
    if (state === "after" && asset.beforeSha256 === asset.afterSha256) {
      const stage = assetStagePath(asset);
      if (fs.existsSync(stage)) {
        if (sha256File(stage) !== asset.afterSha256) throw new Error(`unexpected recovery stage collision at ${stage}`);
        durableRemove(stage);
      }
      const swap = assetSwapPath(asset);
      if (fs.existsSync(swap)) {
        if (sha256File(swap) !== asset.beforeSha256) throw new Error(`unexpected recovery swap collision at ${swap}`);
        durableRemove(swap);
      }
      continue;
    }
    if (state === "before") {
      const stage = assetStagePath(asset);
      if (fs.existsSync(stage)) {
        if (sha256File(stage) !== asset.afterSha256) throw new Error(`unexpected recovery stage collision at ${stage}`);
        durableRemove(stage);
      }
      continue;
    }
    const swap = assetSwapPath(asset);
    if (state === "before-moved") {
      durableRename(swap, asset.path);
    } else if (state === "before-restored") {
      const restoreStage = assetRestoreStagePath(asset);
      if (fs.existsSync(restoreStage)) {
        if (sha256File(restoreStage) !== asset.beforeSha256) throw new Error(`restore stage collision at ${restoreStage}`);
        durableRemove(restoreStage);
      }
      durableRemove(swap);
    } else if (state === "after-moved") {
      const restoreStage = assetRestoreStagePath(asset);
      durableLink(restoreStage, asset.path);
      if (sha256File(asset.path) !== asset.beforeSha256) throw new Error(`rollback readback mismatch at ${asset.path}`);
      durableRemove(restoreStage);
      restoreStageDeletes += 1;
      if (failure?.afterRestoreStageDeletes === restoreStageDeletes) {
        throw new Error("injected forward rollback restore-stage deletion failure");
      }
      durableRemove(swap);
    } else if (state === "created-moved") {
      durableRemove(swap);
    } else if (asset.beforeSha256 == null) {
      if (fs.existsSync(swap)) throw new Error(`target swap collision at ${swap}`);
      failure?.beforeRemovalMove?.();
      durableRename(asset.path, swap);
      if (sha256File(swap) !== asset.afterSha256) {
        if (!fs.existsSync(asset.path)) fs.renameSync(swap, asset.path);
        throw new Error(`target changed during rollback removal: ${asset.path}`);
      }
      removalMoves += 1;
      if (failure?.afterRemovalMoves === removalMoves) throw new Error("injected forward rollback removal failure");
      durableRemove(swap);
    }
    else {
      const backup = backupPath(bridgeRoot, operationId, asset)!;
      if (!fs.existsSync(backup) || sha256File(backup) !== asset.beforeSha256) throw new Error(`missing or invalid immutable backup ${backup}`);
      if (fs.existsSync(swap)) {
        if (sha256File(swap) !== asset.beforeSha256) throw new Error(`unexpected recovery swap collision at ${swap}`);
        durableRemove(swap);
      }
      restoreAssetBytes(asset, backup, () => {
        restoreLinks += 1;
        if (failure?.afterRestoreLinks === restoreLinks) throw new Error("injected forward rollback link failure");
      }, () => {
        restoreStageDeletes += 1;
        if (failure?.afterRestoreStageDeletes === restoreStageDeletes) {
          throw new Error("injected forward rollback restore-stage deletion failure");
        }
      });
    }
    if (currentSha(asset.path) !== asset.beforeSha256) throw new Error(`rollback readback mismatch at ${asset.path}`);
    const stage = assetStagePath(asset);
    if (fs.existsSync(stage)) {
      if (sha256File(stage) !== asset.afterSha256) throw new Error(`unexpected recovery stage collision at ${stage}`);
      durableRemove(stage);
    }
  }
  journal = { ...journal, state: "rolled-back", updatedAt: new Date().toISOString() };
  writeJournal(bridgeRoot, journal);
  return journal;
}

export function forwardSessionApplyPlan(
  session: CodexSession,
  lines: ClaudeTranscriptRecord[],
  targetPath: string,
  wrapperPath: string | null,
): ForwardSessionApplyPlan {
  const transcriptContents = serializeLines(lines);
  let wrapper: ForwardAssetPlan | null = null;
  if (wrapperPath != null) {
    const built: WrapperRecord = {
      ...buildWrapperRecord({
        cliSessionId: session.sessionId, cwd: session.cwdOriginal || session.cwd, lines,
        title: session.codexName || session.title || session.sessionId,
        sandboxPolicy: session.sandboxPolicy, approvalMode: session.approvalMode,
        reasoningEffort: session.reasoningEffort, model: session.model ?? undefined,
      }),
      sessionId: path.basename(wrapperPath, ".json"),
      isArchived: session.isArchived === true,
    };
    const afterContents = JSON.stringify(built, null, 2);
    wrapper = { path: wrapperPath, beforeSha256: currentSha(wrapperPath), afterSha256: sha256Text(afterContents), afterContents };
  }
  return {
    sessionId: session.sessionId,
    operationId: uuid(canonicalOperationSeed({
      sessionId: session.sessionId,
      sourceSha256: session.sourceContentSha256 ?? bundleHash(lines),
      rendererFingerprint: CLAUDE_FORWARD_RENDERER_FINGERPRINT,
      targetPath: path.resolve(targetPath),
      transcriptSha256: sha256Text(transcriptContents),
      wrapperPath: wrapper == null ? null : path.resolve(wrapper.path),
      wrapperSha256: wrapper?.afterSha256 ?? null,
    })),
    sourceSha256: session.sourceContentSha256 ?? "",
    transcript: { path: targetPath, beforeSha256: currentSha(targetPath), afterSha256: sha256Text(transcriptContents), afterContents: transcriptContents },
    wrapper,
  };
}

function canonicalOperationSeed(value: Record<string, unknown>): string {
  return `forward-session:${JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]))}`;
}

function bundleHash(lines: ClaudeTranscriptRecord[]): string {
  return sha256Text(serializeLines(lines));
}

export function deterministicWrapperPath(workspaceDir: string, sessionId: string): string {
  return path.join(workspaceDir, `local_${uuid(`forward-wrapper:${sessionId}`)}.json`);
}
