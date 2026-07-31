import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ClaudeTranscriptLine,
  ClaudeTranscriptRecord,
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
import type { GoalMigrationMode } from "./goal.ts";
import { applyTitlePrefix } from "./map.ts";

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
  goalIdentity: GoalHistoryIdentity = { mode: "skip", sourceGoalSha256: null },
): boolean {
  let latest: ImportHistoryRecord | null = null;
  for (const record of history.records) {
    if (record.contentSha256 !== contentSha256) continue;
    if (latest == null || record.importedAtMs >= latest.importedAtMs) latest = record;
  }
  if (latest == null || storedRenderMode(latest.renderMode) !== renderMode) return false;
  const storedGoalMode = latest.goalMode ?? "skip";
  return storedGoalMode === goalIdentity.mode &&
    (latest.sourceGoalSha256 ?? null) === goalIdentity.sourceGoalSha256 &&
    (latest.targetGoalCapabilityId ?? null) === (goalIdentity.targetCapabilityId ?? null) &&
    (latest.targetGoalFingerprint ?? null) === (goalIdentity.targetFingerprint ?? null);
}

export interface GoalHistoryIdentity {
  mode: GoalMigrationMode;
  sourceGoalSha256: string | null;
  targetCapabilityId?: string | null;
  targetFingerprint?: string | null;
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

/**
 * Where a session's transcript actually is.
 *
 *  - `absent`      no transcript anywhere carries this session id
 *  - `at-expected` it is where the project root says it should be
 *  - `relocated`   it is somewhere else, or in more than one place
 *
 * Claude does not keep a conversation where the import put it. A session whose
 * cwd changed — or whose project directory Claude spelled differently — moves to
 * another project directory under the same id, and deriving a path from the
 * recorded project root then reports "absent" for a conversation that is very
 * much alive. Writing a fresh transcript at the derived path would orphan it,
 * so `relocated` is a verdict of its own and never a licence to create.
 */
export interface TranscriptLocation {
  state: "absent" | "at-expected" | "relocated";
  /** The path the project root implies. */
  expectedPath: string;
  /** Every transcript on disk carrying this session id, in directory order. */
  foundPaths: string[];
  /** Those of them that are not the expected path. */
  relocatedPaths: string[];
}

/**
 * Find a session's transcript by id across every Claude project directory,
 * rather than trusting the path its recorded project root derives.
 */
export function locateTranscript(
  claudeHome: string,
  cwd: string,
  cliSessionId: string,
): TranscriptLocation {
  const expectedPath = transcriptPathFor(claudeHome, cwd, cliSessionId);
  return locateTranscriptFrom(claudeHome, expectedPath, cliSessionId);
}

/** As `locateTranscript`, for callers that already resolved the expected path. */
export function locateTranscriptFrom(
  claudeHome: string,
  expectedPath: string,
  cliSessionId: string,
): TranscriptLocation {
  const projects = path.join(claudeHome, "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    dirs = [];
  }
  const foundPaths: string[] = [];
  for (const dir of dirs.sort()) {
    const candidate = path.join(projects, dir, `${cliSessionId}.jsonl`);
    try {
      if (fs.statSync(candidate).isFile()) foundPaths.push(candidate);
    } catch { /* not a transcript of this session */ }
  }
  const relocatedPaths = foundPaths.filter((found) => !samePath(found, expectedPath));
  const state = foundPaths.length === 0
    ? "absent"
    : relocatedPaths.length > 0 ? "relocated" : "at-expected";
  return { state, expectedPath, foundPaths, relocatedPaths };
}

/**
 * Whether two paths denote the one file. Callers hand us paths in whatever
 * spelling they hold — canonicalized, short-name, or as typed — and a project
 * directory that differs only by case is still the same directory on Windows.
 * Getting this wrong reports a file as relocated from itself.
 */
function samePath(left: string, right: string): boolean {
  const a = resolveRealPath(left);
  const b = resolveRealPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveRealPath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // A path that does not exist cannot be realpathed; its own directory still
    // can, and that is where the spellings diverge.
    const dir = path.dirname(resolved);
    try {
      return path.join(fs.realpathSync.native(dir), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** Serialize transcript lines to newline-delimited JSON. */
export function serializeLines(lines: ClaudeTranscriptRecord[]): string {
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
  lines: ClaudeTranscriptRecord[],
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
  /** Leading prefixes that `titlePrefix` replaces rather than stacks on top of. */
  replaceTitlePrefixes?: string[];
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
  const title = applyTitlePrefix(
    session.codexName || session.title || session.sessionId,
    opts.titlePrefix ?? "",
    opts.replaceTitlePrefixes,
  );
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
  goalIdentity: GoalHistoryIdentity = { mode: "skip", sourceGoalSha256: null },
): ImportHistoryRecord {
  return {
    contentSha256,
    importedAtMs: nowMs,
    importedSessionId: session.sessionId,
    sourceRolloutPath: session.rolloutPath,
    projectRoot: session.cwd,
    renderMode,
    goalMode: goalIdentity.mode,
    sourceGoalSha256: goalIdentity.sourceGoalSha256,
    targetGoalCapabilityId: goalIdentity.targetCapabilityId ?? null,
    targetGoalFingerprint: goalIdentity.targetFingerprint ?? null,
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

/**
 * What a previous import recorded about one session, reduced to what deciding an
 * overwrite needs: when the importer wrote the transcript, and the bytes it left.
 */
export interface PriorImport {
  /** The line between the import's own content and anything written later. */
  importedAtMs: number;
  /** What the importer recorded. Corroboration only; it decides nothing. */
  targetSha256: string | null;
}

/**
 * Prior imports by Claude session id. No entry means nothing is recorded for that
 * session, which is not the same as "nothing happened to it" — see
 * `classifyTargetContent`, where a missing import time yields `undecidable`.
 */
export type PriorImports = ReadonlyMap<string, PriorImport>;

/** What a caller that has no history to offer passes. Every session undecidable. */
export const NO_PRIOR_IMPORTS: PriorImports = new Map();

/**
 * The one place the import history is read on behalf of a plan.
 *
 * Plan building must stay a function of its inputs, so the history is read here —
 * at the command boundary, once per invocation — and threaded onward as data. A
 * plan builder that opened this file itself would take a hidden input, and two
 * runs over the same sessions could then disagree for reasons the plan does not
 * record.
 *
 * A history that is missing, unreadable or malformed yields no entries, which
 * leaves every session exactly where it stands today: `undecidable`, and behind
 * `--allow-overwrite`. Degrading to "safe" is the one thing this must never do.
 */
export function readPriorImports(claudeHome: string): PriorImports {
  return priorImportsFrom(loadImportHistory(claudeHome));
}

/** As `readPriorImports`, for a history already in hand. */
export function priorImportsFrom(history: ImportHistory): PriorImports {
  const byId = new Map<string, PriorImport>();
  for (const record of history.records ?? []) {
    const sessionId = (record as ImportHistoryRecord | null)?.importedSessionId;
    const importedAtMs = (record as ImportHistoryRecord | null)?.importedAtMs;
    // A record that cannot say which session it is, or when, is not evidence.
    if (typeof sessionId !== "string" || sessionId === "") continue;
    if (typeof importedAtMs !== "number" || !Number.isFinite(importedAtMs)) continue;
    const held = byId.get(sessionId);
    if (held != null && held.importedAtMs > importedAtMs) continue;
    const targetSha256 = record.targetSha256;
    byId.set(sessionId, {
      importedAtMs,
      targetSha256: typeof targetSha256 === "string" ? targetSha256 : null,
    });
  }
  return byId;
}
