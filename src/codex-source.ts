import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CodexSession, RolloutLine, SessionMeta } from "./types.ts";
import { normalizeCwd } from "./paths.ts";
import { loadDesktopThreads, loadThreadsByIds } from "./codex-db.ts";
import { loadDesktopSelection, projectForCwd } from "./codex-desktop-state.ts";
import { loadThreadNames, nameFromThreadRow } from "./codex-thread-names.ts";
import { splitUserMessage } from "./preamble.ts";

/** Recursively collect rollout .jsonl files under <codexHome>/sessions. */
export function discoverRolloutFiles(codexHome: string): string[] {
  const root = path.join(codexHome, "sessions");
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  walk(root);
  return out;
}

function tsToMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
      parts.push((b as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

/** Parse a single rollout file into a CodexSession (returns null if it has no usable content). */
export function parseRollout(
  rolloutPath: string,
  opts: ParseOptions = {},
): CodexSession | null {
  const useCompaction = opts.useCodexCompaction !== false;
  let raw: string;
  let sourceContentSha256: string;
  try {
    const bytes = fs.readFileSync(rolloutPath);
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    sourceContentSha256 = createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }

  const meta: SessionMeta = {};
  const items: CodexSession["items"] = [];
  let firstTsMs: number | null = null;
  let lastTsMs: number | null = null;
  let model: string | null = null;
  let compactedAway = 0;

  for (const [lineIndex, originalLine] of raw.split(/\r?\n/).entries()) {
    const line = lineIndex === 0 ? originalLine.replace(/^\uFEFF/, "") : originalLine;
    if (line.trim() === "") continue;
    let rec: RolloutLine;
    try {
      rec = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    const tsMs = tsToMs(rec.timestamp);
    if (tsMs != null) {
      if (firstTsMs == null) firstTsMs = tsMs;
      lastTsMs = tsMs;
    }
    const payload = (rec.payload ?? {}) as Record<string, unknown>;

    if (rec.type === "session_meta") {
      Object.assign(meta, payload as SessionMeta);
      continue;
    }
    if (rec.type === "turn_context") {
      const m = payload["model"];
      if (typeof m === "string" && m !== "") model = m;
      continue;
    }

    // Codex compacted here: everything before is replaced by the shortened
    // context it carried forward.
    if (rec.type === "compacted") {
      const replacement = payload["replacement_history"];
      if (useCompaction) {
        if (Array.isArray(replacement) && replacement.length > 0) {
          compactedAway += items.length;
          items.length = 0;
          for (const it of replacement) {
            if (it && typeof it === "object") {
              items.push({ tsMs, payload: it as Record<string, unknown> });
            }
          }
        }
      } else {
        // Keep the history, but record where Codex compacted. Claude has its own
        // boundary marker and loads only what follows the last one, so the full
        // transcript stays on disk without being replayed in full.
        items.push({ tsMs, payload: { type: "__compact_boundary__" } });
      }
      continue;
    }
    if (rec.type !== "response_item") continue;

    items.push({ tsMs, payload });

  }

  // Derived from the final item list, which compaction may have replaced.
  let messageCount = 0;
  let userMessageCount = 0;
  let title = "";
  for (const { payload } of items) {
    if (payload["type"] !== "message") continue;
    const role = payload["role"];
    if (role === "user" || role === "assistant") messageCount += 1;
    if (role === "assistant") continue;
    const t = blocksToText(payload["content"]);
    if (t === "") continue;
    const { request } = splitUserMessage(String(role ?? "user"), t);
    if (request == null) continue;
    userMessageCount += 1;
    if (title === "") title = request.replace(/\s+/g, " ").slice(0, 100);
  }

  if (items.length === 0) return null;

  // Prefer the per-file UUID from the rollout filename: Codex reuses the same
  // session_meta.id across multiple rollout files when a thread is resumed/forked,
  // so keying on meta.id would make a later file overwrite an earlier transcript.
  // The filename UUID is unique per rollout file -> one file maps to one transcript.
  const sessionId =
    deriveSessionIdFromFilename(rolloutPath) ||
    (typeof meta.id === "string" && meta.id) ||
    randomUUID();

  // Codex sometimes records the Windows extended-length prefix (\\?\C:\...).
  // Strip it so the path matches what Claude Desktop stores as cwd.
  const rawCwd =
    typeof meta.cwd === "string" && meta.cwd !== ""
      ? meta.cwd.replace(/^\\\\\?\\/, "")
      : "";
  const cwd = rawCwd !== "" ? normalizeCwd(rawCwd) : "";
  const source =
    typeof meta.source === "string"
      ? meta.source
      : meta.source != null
        ? JSON.stringify(meta.source)
        : "";
  const isChild = meta.parent_thread_id != null && meta.parent_thread_id !== "";
  if (model == null && typeof meta.model_provider === "string") {
    // model_provider is a provider name, not a model; leave model null unless a turn_context set it.
  }

  return {
    sessionId,
    rolloutPath,
    sourceContentSha256,
    cwd,
    cwdOriginal: rawCwd,
    meta,
    firstTsMs: firstTsMs ?? tsToMs(meta.timestamp),
    lastTsMs: lastTsMs ?? tsToMs(meta.timestamp),
    items,
    model,
    messageCount,
    title,
    source,
    isChild,
    userMessageCount,
    compactedAway,
  };
}

/** rollout-2026-07-24T05-38-12-<uuid>.jsonl -> <uuid> (best effort). */
export function deriveSessionIdFromFilename(rolloutPath: string): string {
  const base = path.basename(rolloutPath).replace(/\.jsonl$/, "");
  const uuidMatch = base.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return uuidMatch ? uuidMatch[0] : base;
}

/** Discover + parse all sessions under a codex home. */
export function loadCodexSessions(
  codexHome: string,
  opts: ParseOptions = {},
): CodexSession[] {
  const files = discoverRolloutFiles(codexHome);
  const sessions: CodexSession[] = [];
  for (const f of files) {
    const s = parseRollout(f, opts);
    if (s) sessions.push(s);
  }
  // newest last-activity first
  sessions.sort((a, b) => (b.lastTsMs ?? 0) - (a.lastTsMs ?? 0));
  return sessions;
}

export interface ParseOptions {
  /**
   * Use the context Codex itself compacted to, instead of the full history.
   *
   * When Codex compacts, it writes a `compacted` item whose `replacement_history`
   * is the shortened context it carried forward — typically a few dozen items in
   * place of thousands. Replaying the full history instead can exceed Claude's
   * context window before the first message. Codex's own importer does no
   * summarising either; it just seeds token counts so its auto-compaction fires
   * on the next turn, which Claude cannot do because it fails first.
   */
  useCodexCompaction?: boolean;
}

export interface DesktopSelectOptions {
  interactiveOnly?: boolean; // drop `codex exec` automation runs
  includeArchived?: boolean;
  useCodexCompaction?: boolean;
}
export interface DesktopSelectResult {
  via: "desktop" | "db" | "scan";
  sessions: CodexSession[];
}

/**
 * Select the conversations Codex Desktop shows in its left sidebar.
 *
 * Preferred ("desktop"): read Codex Desktop's UI state (.codex-global-state.json).
 * Older Desktop builds record an explicit thread->project assignment map, which is
 * the sidebar membership verbatim. Current builds do not: projects are registered
 * with root paths, and membership is the thread index grouped by cwd. Both end up
 * with the same thing — non-archived top-level threads, tagged with their project.
 * (archived/rollout_path/title come from state_*.sqlite).
 *
 * Fallbacks: ("db") replicate the listThreads filter over the whole threads table;
 * ("scan") scan rollout files with the equivalent semantic filter.
 */
export function loadDesktopSessions(
  codexHome: string,
  opts: DesktopSelectOptions = {},
): DesktopSelectResult {
  const selection = loadDesktopSelection(codexHome);
  const names = loadThreadNames(codexHome);
  const nameFor = (r: { id: string; name: string | null; title: string; firstUserMessage: string | null }): string | null =>
    names.get(r.id) ?? nameFromThreadRow(r);

  // Current Codex Desktop keeps no thread->project map: membership is the thread
  // index, and this file only says which projects exist and where they live.
  if (selection && selection.mode === "derived") {
    const rows = loadDesktopThreads(codexHome, opts);
    if (rows) {
      const sessions: CodexSession[] = [];
      for (const r of rows) {
        if (!r.rolloutPath) continue;
        const s = parseRollout(r.rolloutPath, opts);
        if (!s) continue;
        if (s.title === "" && r.title) s.title = r.title.replace(/\s+/g, " ").slice(0, 100);
        s.codexName = nameFor(r);
        if (r.source) s.source = r.source;
        const proj = selection.projectlessThreadIds.has(r.id)
          ? null
          : projectForCwd(selection, r.cwd || s.cwdOriginal || s.cwd);
        s.projectName = proj?.name ?? "(no project)";
        s.hasProject = proj != null;
        s.isArchived = r.archived;
        s.sandboxPolicy = r.sandboxPolicy;
        s.approvalMode = r.approvalMode;
        s.reasoningEffort = r.reasoningEffort;
        sessions.push(s);
      }
      return { via: "desktop", sessions };
    }
  }

  if (selection && selection.mode === "assigned") {
    const ids = [...selection.threadProject.keys()];
    const rows = loadThreadsByIds(codexHome, ids, opts);
    if (rows) {
      const sessions: CodexSession[] = [];
      for (const r of rows) {
        if (!r.rolloutPath) continue;
        if (opts.interactiveOnly && r.source.includes("exec")) continue;
        const s = parseRollout(r.rolloutPath, opts);
        if (!s) continue;
        if (s.title === "" && r.title) s.title = r.title.replace(/\s+/g, " ").slice(0, 100);
        s.codexName = nameFor(r);
        if (r.source) s.source = r.source;
        const proj = selection.threadProject.get(r.id) ?? null;
        s.projectName = proj?.name ?? "(no project)";
        s.hasProject = proj != null;
        s.isArchived = r.archived;
        s.sandboxPolicy = r.sandboxPolicy;
        s.approvalMode = r.approvalMode;
        s.reasoningEffort = r.reasoningEffort;
        sessions.push(s);
      }
      return { via: "desktop", sessions };
    }
  }

  const rows = loadDesktopThreads(codexHome, opts);
  if (rows) {
    const sessions: CodexSession[] = [];
    for (const r of rows) {
      if (!r.rolloutPath) continue;
      const s = parseRollout(r.rolloutPath, opts);
      if (!s) continue;
      if (s.title === "" && r.title) s.title = r.title.replace(/\s+/g, " ").slice(0, 100);
      s.codexName = nameFor(r);
      if (r.source) s.source = r.source;
      s.sandboxPolicy = r.sandboxPolicy;
      s.approvalMode = r.approvalMode;
      s.reasoningEffort = r.reasoningEffort;
      s.isArchived = r.archived;
      sessions.push(s); // DB already ordered by recency
    }
    return { via: "db", sessions };
  }

  // Fallback: file scan + semantic Desktop-equivalent filter.
  // (archived threads are physically moved to archived_sessions/, so scanning
  // sessions/ already excludes them.)
  const sessions = loadCodexSessions(codexHome, opts).filter((s) => {
    if (s.isChild) return false;
    if (s.source.includes("subagent")) return false;
    if (opts.interactiveOnly && s.source.includes("exec")) return false;
    return true;
  });
  return { via: "scan", sessions };
}
