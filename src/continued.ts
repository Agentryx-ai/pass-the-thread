// Tell "Claude replayed the history back into the file" apart from "the user
// carried on the conversation".
//
// Both make a transcript differ from what this tool wrote, and `--force` used to
// treat them alike — so a re-import could take a message the user had sent with
// it, unrecoverably. Only the second is worth refusing over.
//
// Replayed turns keep their original Codex timestamps: a forked transcript
// observed after a real continuation carried 2026-07-13/14 stamps for every
// replayed turn and 2026-07-25 only for the new one. So the import's own lines
// are never mistaken for later ones.
//
// The timestamp alone is not enough, though. Claude writes tool results, its
// compaction notice and harness notifications as `user` lines too, all stamped
// after the import — see `isAuthored`.
import fs from "node:fs";
import { createHash } from "node:crypto";

export interface Continuation {
  /** Non-meta user turns written after the import. */
  turns: number;
  /** The first of them, for a message the user can recognise. */
  firstText: string;
  /** When it was sent. */
  firstAtMs: number | null;
}

/**
 * What an existing transcript is, judged by what is written in it.
 *
 *  - `unchanged`   nothing at all was added after the import
 *  - `trivial`     only lines nobody authored were added — tool results, the
 *                  compaction notice, harness notifications
 *  - `modified`    somebody typed a turn, or Claude answered one
 *  - `undecidable` the file cannot be placed relative to the import
 *
 * `modified` and `undecidable` are never overwrite-eligible. The stored
 * `targetSha256` decides nothing here: Claude rewrites a transcript byte-for-byte
 * whenever the conversation is opened, so a hash mismatch says only "Claude
 * touched the file", which is true of practically every imported session and is
 * not evidence that anything of the user's is in it.
 */
export type TargetContentClass = "unchanged" | "modified" | "trivial" | "undecidable";

/**
 * Line types Claude writes without a timestamp, and only for a session somebody
 * has worked in. Measured over the 42 imported transcripts: 1196 `last-prompt`,
 * 921 `custom-title` and 56 `relocated` lines, every one of them in a session
 * that had been continued and none in the 22 that had not. `mode` is deliberately
 * absent: Claude writes it merely on opening a session, so it proves nothing.
 */
const MARKER_TYPES = new Set(["last-prompt", "custom-title", "relocated"]);

export interface TargetContentVerdict {
  classification: TargetContentClass;
  /** Post-import turns somebody typed, when there are any. */
  continuation: Continuation | null;
  /** Post-import `assistant` lines. Claude only writes these in reply to a turn. */
  assistantLines: number;
  /** Post-import `user` lines nobody authored. */
  incidentalLines: number;
  /** Why nothing could be decided; null unless `undecidable`. */
  undecidable: string | null;
  /**
   * Unstamped lines only Claude writes, and only once a session has been worked
   * in: `last-prompt`, `custom-title`, `relocated`. The importer emits none of
   * them, so one is evidence of its own.
   */
  markerLines: number;
  /**
   * Whether the bytes still match what the importer recorded. Reported as
   * corroboration and never consulted by the classification.
   */
  sha256Matches: boolean | null;
}

export interface ClassifyTargetOptions {
  /** The `targetSha256` the importer stored, for corroboration only. */
  expectedSha256?: string | null;
}

/**
 * Classify an existing transcript by its content.
 *
 * Replayed turns keep their original Codex timestamps, so the import's own lines
 * are never mistaken for later ones; only what carries a stamp after
 * `importedAtMs` counts. Without an import time there is no "after", so the file
 * is `undecidable` rather than assumed safe.
 */
export function classifyTargetContent(
  targetPath: string,
  importedAtMs: number | undefined | null,
  options: ClassifyTargetOptions = {},
): TargetContentVerdict {
  const expected = options.expectedSha256 ?? null;
  let raw: string | null;
  try {
    raw = fs.readFileSync(targetPath, "utf8");
  } catch {
    raw = null;
  }
  const sha256Matches = raw == null || expected == null
    ? null
    : createHash("sha256").update(raw, "utf8").digest("hex") === expected;

  let markerLines = 0;
  const undecided = (reason: string): TargetContentVerdict => ({
    classification: "undecidable",
    continuation: null,
    assistantLines: 0,
    incidentalLines: 0,
    undecidable: reason,
    markerLines,
    sha256Matches,
  });

  if (raw == null) return undecided(`the transcript could not be read: ${targetPath}`);
  if (importedAtMs == null) return undecided("no import time is recorded for this session");

  let turns = 0;
  let firstText = "";
  let firstAtMs: number | null = null;
  let assistantLines = 0;
  let incidentalLines = 0;
  // A line that cannot be placed does not stop the scan: whatever else the file
  // holds is still worth finding, and a message of the user's outweighs it.
  let unplaceable: string | null = null;
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    let rec: AnyLine;
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      // A transcript that cannot be parsed cannot be shown to be free of the
      // user's messages, so it is not something to overwrite unattended.
      unplaceable ??= `line ${index + 1} of ${targetPath} is not JSON`;
      continue;
    }
    // Some of Claude's own lines carry no timestamp and so cannot be placed
    // against the import, but they are written only once a session has been
    // worked in: the prompt last typed into it, a title the user gave it, the
    // note that Claude moved it. The importer writes none of them, so finding
    // one says the session was touched even though nothing datable was added.
    if (typeof rec.type === "string" && MARKER_TYPES.has(rec.type)) {
      markerLines += 1;
      continue;
    }
    // Only conversation lines can carry a message. Summaries, system notices and
    // file-history snapshots are Claude's bookkeeping and are often unstamped.
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN;
    if (Number.isNaN(at)) {
      unplaceable ??= `a ${rec.type} line at ${index + 1} of ${targetPath} has no usable timestamp`;
      continue;
    }
    // A second's slack: our own lines are stamped from Codex and are far older,
    // so this only guards against clock jitter around the write itself.
    if (at <= importedAtMs + 1000) continue;

    if (rec.type === "assistant") {
      assistantLines += 1;
      continue;
    }
    // Tool results, the compaction notice and harness notifications come back as
    // user lines too, and are not something anyone typed.
    const text = rec.isMeta === true || !isAuthored(rec) ? "" : userText(rec.message?.content);
    if (text === "") {
      incidentalLines += 1;
      continue;
    }
    turns += 1;
    if (firstText === "") {
      firstText = text.replace(/\s+/g, " ").slice(0, 80);
      firstAtMs = at;
    }
  }

  const continuation = turns > 0 ? { turns, firstText, firstAtMs } : null;
  if (turns === 0 && assistantLines === 0 && markerLines === 0 && unplaceable != null) {
    return { ...undecided(unplaceable), incidentalLines };
  }
  // A marker cannot say what was done, only that something was, so it settles
  // the question the same way a turn does: this is not a transcript to write over.
  const classification: TargetContentClass = turns > 0 || assistantLines > 0 || markerLines > 0
    ? "modified"
    : incidentalLines > 0 ? "trivial" : "unchanged";
  return { classification, continuation, assistantLines, incidentalLines, undecidable: null, markerLines, sha256Matches };
}

/** Only a transcript shown to hold nothing of the user's may be written over. */
export function overwriteEligible(verdict: TargetContentVerdict): boolean {
  return verdict.classification === "unchanged" || verdict.classification === "trivial";
}

/**
 * Messages the user sent after `importedAtMs`, or null when there are none —
 * including when the file is unreadable, since nothing can be claimed then.
 */
export function findContinuation(
  targetPath: string,
  importedAtMs: number | undefined,
): Continuation | null {
  return classifyTargetContent(targetPath, importedAtMs).continuation;
}

interface AnyLine {
  type?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  toolUseResult?: unknown;
  origin?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

/**
 * Whether a `user` line is one somebody typed.
 *
 * Claude writes several kinds of `user` line that nobody authored, and does not
 * mark them `isMeta` — that is this tool's own convention. Each carries a field
 * that says what it is, observed on a transcript continued in Claude Desktop:
 *
 * - `toolUseResult` — a tool result. Its text reads `[tool result <id>]`, with
 *   `[object Object]` under it, so there is nothing to match on in the text.
 * - `isCompactSummary` — "This session is being continued from a previous
 *   conversation…", written when Claude compacts.
 * - `origin.kind` — `"human"` on a typed message, `"task-notification"` on the
 *   ones the harness injects. Older lines carry no `origin` at all, so this
 *   rejects a known non-human kind rather than requiring a human one.
 * - `<local-command-stdout>` — what a slash command printed. The
 *   `<command-name>` line next to it is the command the user ran, and counts.
 */
function isAuthored(rec: AnyLine): boolean {
  if (rec.toolUseResult !== undefined) return false;
  if (rec.isCompactSummary === true) return false;
  const kind = (rec.origin as { kind?: unknown } | null | undefined)?.kind;
  if (typeof kind === "string" && kind !== "human") return false;
  const content = rec.message?.content;
  if (typeof content === "string" && content.startsWith("<local-command-stdout>")) return false;
  return true;
}

/** Text the user typed, from either shape Claude writes for a user message. */
function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if ((b as { type?: unknown }).type !== "text") continue;
    const t = (b as { text?: unknown }).text;
    if (typeof t === "string") parts.push(t);
  }
  return parts.join("\n").trim();
}
