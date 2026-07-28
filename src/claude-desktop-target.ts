// Register imported transcripts with Claude Desktop's session list.
//
// Claude Desktop (Code) does NOT list ~/.claude/projects/*.jsonl directly. Its
// conversation list is built from "wrapper records" under
//   <userData>/Claude/claude-code-sessions/<accountId>/<deviceId>/local_<uuid>.json
// where <userData> is %APPDATA% on Windows, ~/Library/Application Support on
// macOS and $XDG_CONFIG_HOME (or ~/.config) on Linux.
// Each record points at a transcript via `cliSessionId` + `cwd`
// (transcript path = <claudeHome>/projects/<cwd.replace(/[^a-zA-Z0-9]/g,"-")>/<cliSessionId>.jsonl).
//
// Writing a transcript alone is therefore invisible; a wrapper record is required.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeTranscriptRecord } from "./types.ts";
import { mapEffort, mapPermissionMode } from "./policy.ts";

export interface WrapperRecord {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  originCwd: string;
  lastFocusedAt: number;
  createdAt: number;
  lastActivityAt: number;
  model: string;
  effort: string;
  isArchived: boolean;
  title: string;
  titleSource: string;
  permissionMode: string;
  completedTurns: number;
  bridgeSessionIds: string[];
  alwaysAllowedReasons: unknown[];
  sessionPermissionUpdates: unknown[];
  classifierSummaryEnabled: boolean;
  spawnSeed: Record<string, unknown>;
}

/**
 * Claude Desktop's Electron user-data directory, which is where
 * `claude-code-sessions` lives. Electron's `app.getPath("userData")` resolves
 * per platform, so this has to as well — on macOS the Windows %APPDATA% layout
 * does not exist and the records would silently never be found.
 */
export function resolveDesktopDataDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude");
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg && xdg !== "" ? xdg : path.join(home, ".config"), "Claude");
}

/** Default root of Claude Desktop's session-record store. */
export function resolveDesktopSessionsRoot(override?: string): string {
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(resolveDesktopDataDir(), "claude-code-sessions");
}

/**
 * The account Claude Code is signed in to, as <accountId>/<deviceId> — which is
 * exactly the directory layout under `claude-code-sessions`. Reading it beats
 * guessing from file counts when more than one account has records on disk.
 */
export function signedInWorkspaceDir(
  sessionsRoot: string,
  claudeHome: string,
): string | null {
  const candidates = [
    path.join(claudeHome, ".claude.json"),
    path.join(os.homedir(), ".claude.json"),
  ];
  for (const p of candidates) {
    let account: { accountUuid?: unknown; organizationUuid?: unknown } | undefined;
    try {
      account = (
        JSON.parse(fs.readFileSync(p, "utf8")) as {
          oauthAccount?: { accountUuid?: unknown; organizationUuid?: unknown };
        }
      ).oauthAccount;
    } catch {
      continue;
    }
    const a = account?.accountUuid;
    const o = account?.organizationUuid;
    if (typeof a !== "string" || typeof o !== "string" || a === "" || o === "") continue;
    const dir = path.join(sessionsRoot, a, o);
    if (safeIsDir(dir)) return dir;
  }
  return null;
}

/** How many <accountId>/<deviceId> directories hold records at all. */
export function countWorkspaceDirs(sessionsRoot: string): number {
  let n = 0;
  let accounts: string[];
  try {
    accounts = fs.readdirSync(sessionsRoot);
  } catch {
    return 0;
  }
  for (const a of accounts) {
    const pa = path.join(sessionsRoot, a);
    if (!safeIsDir(pa)) continue;
    for (const b of fs.readdirSync(pa)) {
      const pb = path.join(pa, b);
      if (!safeIsDir(pb)) continue;
      if (fs.readdirSync(pb).some((f) => f.startsWith("local_") && f.endsWith(".json"))) {
        n += 1;
      }
    }
  }
  return n;
}

/**
 * Pick the active <accountId>/<deviceId> directory: the one whose records were
 * modified most recently (ties broken by having non-archived records).
 */
export function findActiveWorkspaceDir(sessionsRoot: string): string | null {
  let best: { dir: string; mtime: number; active: number } | null = null;
  let accounts: string[];
  try {
    accounts = fs.readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const a of accounts) {
    const pa = path.join(sessionsRoot, a);
    if (!safeIsDir(pa)) continue;
    for (const b of fs.readdirSync(pa)) {
      const pb = path.join(pa, b);
      if (!safeIsDir(pb)) continue;
      let mtime = 0;
      let active = 0;
      for (const f of fs.readdirSync(pb)) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        const fp = path.join(pb, f);
        try {
          mtime = Math.max(mtime, fs.statSync(fp).mtimeMs);
          const rec = JSON.parse(fs.readFileSync(fp, "utf8")) as { isArchived?: boolean };
          if (!rec.isArchived) active += 1;
        } catch {
          /* ignore unreadable record */
        }
      }
      if (mtime === 0) continue;
      if (
        best == null ||
        active > best.active ||
        (active === best.active && mtime > best.mtime)
      ) {
        best = { dir: pb, mtime, active };
      }
    }
  }
  return best?.dir ?? null;
}

/** cliSessionIds already registered in this workspace dir (for dedup). */
export function existingCliSessionIds(workspaceDir: string): Set<string> {
  const out = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(workspaceDir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, f), "utf8"),
      ) as { cliSessionId?: string };
      if (typeof rec.cliSessionId === "string") out.add(rec.cliSessionId);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Read back a record this tool wrote, by the `sessionId` it was written under.
 *
 * `cliSessionId` cannot be used for this: Claude repoints it at a session of its
 * own once the conversation is continued, and the record stops looking like
 * ours. The record's own id is stable — it is the file name — so it survives
 * that, and it is what tells "still registered for the import" apart from "now
 * Claude's, leave it alone".
 */
export function readRecord(
  workspaceDir: string,
  sessionId: string,
): { path: string; record: WrapperRecord } | null {
  const p = path.join(workspaceDir, `${sessionId}.json`);
  try {
    return { path: p, record: JSON.parse(fs.readFileSync(p, "utf8")) as WrapperRecord };
  } catch {
    return null; // deleted, or never ours
  }
}

/**
 * Whether a record already shows the name Codex shows, allowing for a
 * `--title-prefix` in front of it. Such a title is correct however old the
 * transcript is, and re-syncing it from one written before imports read Codex's
 * names would put the first message back over the name.
 */
export function titleShowsCodexName(
  recordTitle: unknown,
  codexName: string | null | undefined,
): boolean {
  const name = codexName?.trim();
  if (name == null || name === "") return false;
  return typeof recordTitle === "string" && recordTitle.endsWith(name);
}

export interface OwnedRecords {
  /** A record we wrote that still points at the imported transcript. */
  current: { path: string; record: WrapperRecord } | null;
  /**
   * Records we wrote that Claude has since repointed at a session of its own —
   * it forks an imported conversation when it is continued. These belong to
   * Claude now and hold whatever was said in them, so they are never rewritten.
   */
  repointed: Array<{ path: string; record: WrapperRecord }>;
}

/** Sort the records this tool wrote for one conversation into still-ours and gone. */
export function ourRecords(
  workspaceDir: string,
  recordSessionIds: readonly string[],
  cliSessionId: string,
): OwnedRecords {
  const out: OwnedRecords = { current: null, repointed: [] };
  for (const id of recordSessionIds) {
    const entry = readRecord(workspaceDir, id);
    if (entry == null) continue;
    if (entry.record.cliSessionId === cliSessionId) out.current ??= entry;
    else out.repointed.push(entry);
  }
  return out;
}

/**
 * Locate a record pointing at a given transcript. Used to refresh a record this
 * tool created earlier; records created by Claude itself are never touched,
 * because their cliSessionId is Claude's own and never matches an imported one.
 */
export function findRecordFor(
  workspaceDir: string,
  cliSessionId: string,
): { path: string; record: WrapperRecord } | null {
  let files: string[];
  try {
    files = fs.readdirSync(workspaceDir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
    const p = path.join(workspaceDir, f);
    try {
      const record = JSON.parse(fs.readFileSync(p, "utf8")) as WrapperRecord;
      if (record.cliSessionId === cliSessionId) return { path: p, record };
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Every record this tool wrote, keyed by the transcript it points at. */
export function recordsByCliSessionId(
  workspaceDir: string,
): Map<string, { path: string; record: WrapperRecord }> {
  const out = new Map<string, { path: string; record: WrapperRecord }>();
  let files: string[];
  try {
    files = fs.readdirSync(workspaceDir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
    const p = path.join(workspaceDir, f);
    try {
      const record = JSON.parse(fs.readFileSync(p, "utf8")) as WrapperRecord;
      if (typeof record.cliSessionId === "string") out.set(record.cliSessionId, { path: p, record });
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Update just the display title, leaving the rest of the record alone. */
export function setRecordTitle(recordPath: string, record: WrapperRecord, title: string): void {
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, title }, null, 2), "utf8");
}

/** Rewrite a record in place, keeping its identity and creation time. */
export function refreshWrapperRecord(
  recordPath: string,
  previous: WrapperRecord,
  next: WrapperRecord,
): void {
  const merged: WrapperRecord = {
    ...next,
    sessionId: previous.sessionId,
    createdAt: previous.createdAt,
    isArchived: previous.isArchived,
  };
  fs.writeFileSync(recordPath, JSON.stringify(merged, null, 2), "utf8");
}

export interface BuildRecordInput {
  cliSessionId: string;
  /** Original-cased cwd (Codex session cwd). */
  cwd: string;
  lines: ClaudeTranscriptRecord[];
  title: string;
  model?: string;
  /** Codex policy, mapped to Claude's single permissionMode when present. */
  sandboxPolicy?: string | null;
  approvalMode?: string | null;
  reasoningEffort?: string | null;
}

export function buildWrapperRecord(input: BuildRecordInput): WrapperRecord {
  const first = input.lines[0];
  const last = input.lines[input.lines.length - 1];
  const createdAt = first ? Date.parse(first.timestamp) : Date.now();
  const lastActivityAt = last ? Date.parse(last.timestamp) : createdAt;
  const completedTurns = input.lines.filter((l) => l.type === "user").length;
  return {
    sessionId: `local_${randomUUID()}`,
    cliSessionId: input.cliSessionId,
    cwd: input.cwd,
    originCwd: input.cwd,
    lastFocusedAt: lastActivityAt,
    createdAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
    lastActivityAt: Number.isNaN(lastActivityAt) ? Date.now() : lastActivityAt,
    model: input.model ?? "claude-opus-5",
    effort: mapEffort(input.reasoningEffort),
    isArchived: false,
    title: input.title,
    titleSource: "auto",
    permissionMode: mapPermissionMode(input.sandboxPolicy, input.approvalMode),
    completedTurns,
    bridgeSessionIds: [],
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
    classifierSummaryEnabled: true,
    spawnSeed: {},
  };
}

export function writeWrapperRecord(
  workspaceDir: string,
  record: WrapperRecord,
): string {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const out = path.join(workspaceDir, `${record.sessionId}.json`);
  fs.writeFileSync(out, JSON.stringify(record, null, 2), "utf8");
  return out;
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
