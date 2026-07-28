import fs from "node:fs";
import path from "node:path";
import {
  countWorkspaceDirs,
  findActiveWorkspaceDir,
  resolveDesktopSessionsRoot,
  signedInWorkspaceDir,
  type WrapperRecord,
} from "./claude-desktop-target.ts";
import { transcriptPathFor } from "./claude-target.ts";

export interface ClaudeDesktopSourceSession {
  wrapperPath: string;
  wrapperSessionId: string;
  cliSessionId: string | null;
  /** Stable Desktop identity. Unlike cliSessionId, this is not repointed. */
  sessionId: string;
  cwd: string;
  title: string;
  isArchived?: boolean;
  archiveState?: "active" | "archived" | "unknown";
  archiveProvenance?: "claude-wrapper-isArchived" | "claude-wrapper-missing-isArchived";
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
  transcriptPath: string | null;
  transcriptExists: boolean;
  transcriptStatus: "available" | "missing" | "unavailable" | "ambiguous";
}

export interface ClaudeDesktopInventory {
  workspaceDir: string;
  sessions: ClaudeDesktopSourceSession[];
  unreadableRecords: string[];
}

/**
 * Resolve the authoritative account/device record directory. With multiple
 * stores we fail closed unless the signed-in account identifies one exactly.
 */
export function resolveClaudeDesktopWorkspace(
  claudeHome: string,
  sessionsRoot = resolveDesktopSessionsRoot(),
): string {
  const signedIn = signedInWorkspaceDir(sessionsRoot, claudeHome);
  if (signedIn) return signedIn;
  const count = countWorkspaceDirs(sessionsRoot);
  if (count === 1) {
    const only = findActiveWorkspaceDir(sessionsRoot);
    if (only) return only;
  }
  if (count === 0) throw new Error(`no Claude Desktop session store found under ${sessionsRoot}`);
  throw new Error(
    `Claude Desktop account is ambiguous (${count} stores); provide an explicit workspace directory`,
  );
}

export function inventoryClaudeDesktop(
  claudeHome: string,
  workspaceDir: string,
): ClaudeDesktopInventory {
  const sessions: ClaudeDesktopSourceSession[] = [];
  const unreadableRecords: string[] = [];
  const transcriptIndex = new Map<string, string[]>();
  const projectsRoot = path.join(claudeHome, "projects");
  try {
    for (const project of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(projectsRoot, project.name);
      for (const transcript of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!transcript.isFile() || !transcript.name.endsWith(".jsonl") || transcript.name.startsWith("agent-")) continue;
        const id = transcript.name.slice(0, -".jsonl".length);
        const bucket = transcriptIndex.get(id) ?? [];
        bucket.push(path.join(projectDir, transcript.name));
        transcriptIndex.set(id, bucket);
      }
    }
  } catch {
    // Per-record cwd lookup below still provides a bounded fast path.
  }
  let files: string[];
  try {
    files = fs.readdirSync(workspaceDir).filter((name) =>
      name.startsWith("local_") && name.endsWith(".json"));
  } catch (error) {
    throw new Error(`cannot read Claude Desktop workspace ${workspaceDir}: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const name of files.sort()) {
    const wrapperPath = path.join(workspaceDir, name);
    let record: WrapperRecord;
    try {
      record = JSON.parse(fs.readFileSync(wrapperPath, "utf8")) as WrapperRecord;
    } catch {
      unreadableRecords.push(wrapperPath);
      continue;
    }
    const extended = record as WrapperRecord & {
      unarchivedCliSessionId?: unknown;
      transcriptUnavailable?: unknown;
    };
    if (typeof record.sessionId !== "string" || typeof record.cwd !== "string") {
      unreadableRecords.push(wrapperPath);
      continue;
    }
    const cliSessionId = typeof record.cliSessionId === "string"
      ? record.cliSessionId
      : typeof extended.unarchivedCliSessionId === "string"
        ? extended.unarchivedCliSessionId
        : null;
    if (cliSessionId == null && extended.transcriptUnavailable !== true) {
      unreadableRecords.push(wrapperPath);
      continue;
    }
    const expected = cliSessionId == null ? null : transcriptPathFor(claudeHome, record.cwd, cliSessionId);
    const indexed = cliSessionId == null ? [] : transcriptIndex.get(cliSessionId) ?? [];
    const candidates = [...new Set([
      ...(expected && fs.existsSync(expected) ? [path.resolve(expected)] : []),
      ...indexed.map((candidate) => path.resolve(candidate)),
    ].map((candidate) => process.platform === "win32" ? candidate.toLowerCase() : candidate))];
    let transcriptStatus: ClaudeDesktopSourceSession["transcriptStatus"];
    let transcriptPath: string | null = null;
    if (cliSessionId == null) transcriptStatus = "unavailable";
    else if (candidates.length === 0) transcriptStatus = "missing";
    else if (candidates.length > 1) transcriptStatus = "ambiguous";
    else {
      transcriptStatus = "available";
      transcriptPath = indexed.find((candidate) =>
        (process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate)) === candidates[0]) ?? expected;
    }
    const archiveKnown = typeof record.isArchived === "boolean";
    sessions.push({
      wrapperPath,
      wrapperSessionId: record.sessionId,
      cliSessionId,
      sessionId: record.sessionId,
      cwd: record.cwd,
      title: typeof record.title === "string" ? record.title : "",
      ...(archiveKnown ? { isArchived: record.isArchived } : {}),
      archiveState: archiveKnown ? (record.isArchived ? "archived" : "active") : "unknown",
      archiveProvenance: archiveKnown ? "claude-wrapper-isArchived" : "claude-wrapper-missing-isArchived",
      createdAtMs: Number.isFinite(record.createdAt) ? Number(record.createdAt) : null,
      lastActivityAtMs: Number.isFinite(record.lastActivityAt) ? Number(record.lastActivityAt) : null,
      transcriptPath,
      transcriptExists: transcriptStatus === "available",
      transcriptStatus,
    });
  }
  sessions.sort((left, right) =>
    (right.lastActivityAtMs ?? -Infinity) - (left.lastActivityAtMs ?? -Infinity) ||
    left.sessionId.localeCompare(right.sessionId));
  return { workspaceDir, sessions, unreadableRecords };
}
