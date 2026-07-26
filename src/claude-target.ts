import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ClaudeTranscriptLine,
  CodexSession,
  ImportHistory,
  ImportHistoryRecord,
} from "./types.ts";
import { encodeProjectDir } from "./paths.ts";
import {
  decodeCanonicalUtf8,
  inertHistoricalNotice,
  storedRenderMode,
  type RenderMode,
} from "./render-mode.ts";

const HISTORY_FILE = "codex-import-history.json";

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * How an existing transcript at the target path relates to this tool.
 *  - `absent`   nothing there yet
 *  - `ours`     byte-identical to what we last wrote
 *  - `modified` we wrote it, but it has changed since (Claude appends when a
 *               conversation is opened or continued) — overwriting loses that
 *  - `foreign`  a transcript this tool never wrote
 */
export type TargetState = "absent" | "ours" | "modified" | "foreign";

export function inspectTarget(
  targetPath: string,
  previousTargetSha: string | undefined,
): TargetState {
  if (!fs.existsSync(targetPath)) return "absent";
  if (previousTargetSha == null) return "foreign";
  return sha256File(targetPath) === previousTargetSha ? "ours" : "modified";
}

export function loadImportHistory(claudeHome: string): ImportHistory {
  const p = path.join(claudeHome, HISTORY_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as ImportHistory;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.records)) return parsed;
  } catch {
    /* fall through to empty */
  }
  return { version: 1, records: [] };
}

export function saveImportHistory(claudeHome: string, history: ImportHistory): void {
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(
    path.join(claudeHome, HISTORY_FILE),
    JSON.stringify(history, null, 2),
    "utf8",
  );
}

export function alreadyImported(
  history: ImportHistory,
  contentSha256: string,
  renderMode: RenderMode = "semantic",
): boolean {
  let latest: ImportHistoryRecord | null = null;
  for (const record of history.records) {
    if (record.contentSha256 !== contentSha256) continue;
    if (latest == null || record.importedAtMs >= latest.importedAtMs) latest = record;
  }
  return latest != null && storedRenderMode(latest.renderMode) === renderMode;
}

export function targetPathFor(
  claudeHome: string,
  session: CodexSession,
): { projectDir: string; targetPath: string } {
  const dirName =
    session.cwd && session.cwd !== ""
      ? encodeProjectDir(session.cwd)
      : "-codex-import-unknown";
  const projectDir = path.join(claudeHome, "projects", dirName);
  const targetPath = path.join(projectDir, `${session.sessionId}.jsonl`);
  return { projectDir, targetPath };
}

/**
 * Where a session record's transcript lives. Same rule as `targetPathFor`, but
 * driven by a record rather than a Codex session — needed to look inside a
 * conversation Claude forked out of an import, which no Codex session names.
 */
export function transcriptPathFor(
  claudeHome: string,
  cwd: string,
  cliSessionId: string,
): string {
  return path.join(claudeHome, "projects", encodeProjectDir(cwd), `${cliSessionId}.jsonl`);
}

/** Serialize transcript lines to newline-delimited JSON. */
export function serializeLines(lines: ClaudeTranscriptLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
}

export interface WriteResult {
  targetPath: string;
  bytes: number;
  lineCount: number;
  sha256: string;
}

export function writeTranscript(
  claudeHome: string,
  session: CodexSession,
  lines: ClaudeTranscriptLine[],
): WriteResult {
  const { projectDir, targetPath } = targetPathFor(claudeHome, session);
  fs.mkdirSync(projectDir, { recursive: true });
  const data = serializeLines(lines);
  fs.writeFileSync(targetPath, data, "utf8");
  return {
    targetPath,
    bytes: Buffer.byteLength(data),
    lineCount: lines.length,
    sha256: sha256Text(data),
  };
}

export interface VerbatimMapOptions {
  /** Value written to the Claude transcript line's version field. */
  version?: string;
  /** Prefix prepended to Claude's display title. */
  titlePrefix?: string;
}

/**
 * Render the complete Codex rollout as one inert Claude metadata message.
 *
 * The second text block is exactly the source file decoded as strict UTF-8:
 * no trimming, newline conversion, normalization, parsing, or reserialization.
 * `isMeta` prevents Claude from treating source controls or tool syntax as a
 * live user turn. The source file itself is read-only and never modified.
 */
export function mapVerbatimRolloutToClaudeLines(
  session: CodexSession,
  opts: VerbatimMapOptions = {},
): ClaudeTranscriptLine[] {
  const source = fs.readFileSync(session.rolloutPath);
  const literal = decodeCanonicalUtf8(source);
  if (literal === "") return [];

  const timestampMs = session.firstTsMs ?? session.lastTsMs ?? 0;
  const timestamp = new Date(Number.isFinite(timestampMs) ? timestampMs : 0).toISOString();
  const title = `${opts.titlePrefix ?? ""}${session.codexName || session.title || session.sessionId}`;
  const line: ClaudeTranscriptLine = {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: session.cwd,
    sessionId: session.sessionId,
    version: opts.version ?? "0.0.0-codex-import",
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: inertHistoricalNotice("Codex rollout JSONL") },
        { type: "text", text: literal },
      ],
    },
    uuid: randomUUID(),
    timestamp,
    customTitle: title,
    isMeta: true,
  };
  const gitBranch = session.meta.git?.branch;
  if (gitBranch) line.gitBranch = gitBranch;
  return [line];
}

export function makeHistoryRecord(
  session: CodexSession,
  contentSha256: string,
  nowMs: number,
  targetSha256?: string,
  renderMode: RenderMode = "semantic",
): ImportHistoryRecord {
  return {
    contentSha256,
    importedAtMs: nowMs,
    importedSessionId: session.sessionId,
    sourceRolloutPath: session.rolloutPath,
    projectRoot: session.cwd,
    renderMode,
    targetSha256,
  };
}

/** Most recent record for a session, if any. */
export function lastRecordFor(
  history: ImportHistory,
  sessionId: string,
): ImportHistoryRecord | null {
  let found: ImportHistoryRecord | null = null;
  for (const r of history.records) {
    if (r.importedSessionId !== sessionId) continue;
    if (found == null || r.importedAtMs >= found.importedAtMs) found = r;
  }
  return found;
}
