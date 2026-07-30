// Make a converted transcript replayable.
//
// Codex records tool calls and their outputs as independent, flat items, so a
// straight conversion can produce shapes the Messages API rejects on the next
// turn: an assistant message carrying several `tool_use` blocks whose results
// arrive as separate user messages, tool calls that never got an output (aborted
// turns, truncated sessions), and empty messages. Each of those fails a resume
// with a 400, so repair them at import time.
import { randomUUID } from "node:crypto";
import type { AnthropicBlock, ClaudeTranscriptLine, ClaudeTranscriptRecord } from "./types.ts";

/** Default ceiling on a converted transcript, in characters (~285K tokens). */
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 1_000_000;

export const MISSING_RESULT_TEXT =
  "[codex-to-claude] no tool result was recorded in the source session";

function blocksOf(line: ClaudeTranscriptRecord): AnthropicBlock[] {
  if (line.type === "attachment") return [];
  const c = line.message?.content;
  if (typeof c === "string") return c === "" ? [] : [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

function isPureToolResult(line: ClaudeTranscriptRecord): line is ClaudeTranscriptLine {
  const b = blocksOf(line);
  return (
    line.type === "user" && b.length > 0 && b.every((x) => x.type === "tool_result")
  );
}

/**
 * Drop lines that repeat an earlier one exactly.
 *
 * Claude appends the history it replayed when an imported conversation is opened
 * or continued, which leaves every message in the file twice. A replayed copy has
 * a fresh uuid but the same role, timestamp and body, so identity is taken from
 * those three and the first occurrence wins. Genuinely repeated messages ("yes",
 * "resume") survive because their timestamps differ.
 */
export function dedupeLines(lines: ClaudeTranscriptLine[]): ClaudeTranscriptLine[];
export function dedupeLines(lines: ClaudeTranscriptRecord[]): ClaudeTranscriptRecord[];
export function dedupeLines(lines: ClaudeTranscriptRecord[]): ClaudeTranscriptRecord[] {
  const seen = new Set<string>();
  const out: ClaudeTranscriptRecord[] = [];
  for (const line of lines) {
    const payload = line.type === "attachment" ? line.attachment : line.message?.content ?? null;
    const key = `${line.type}\0${line.timestamp}\0${JSON.stringify(payload)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * Guarantees, in order:
 *  - no empty messages
 *  - every assistant `tool_use` is answered, in the immediately following user
 *    message, by a `tool_result` with the same id (synthesised when absent)
 *  - the transcript starts with a user message
 *  - `parentUuid` forms a single chain over the final lines
 */
export function repairTranscript(
  input: ClaudeTranscriptLine[],
): ClaudeTranscriptLine[];
export function repairTranscript(input: ClaudeTranscriptRecord[]): ClaudeTranscriptRecord[];
export function repairTranscript(input: ClaudeTranscriptRecord[]): ClaudeTranscriptRecord[] {
  const lines = dedupeLines(input);
  const out: ClaudeTranscriptRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === "attachment") { out.push(line); continue; }
    // Structural markers (compact boundary) carry no message content.
    if (line.type === "system") { out.push(line); continue; }
    if (blocksOf(line).length === 0) continue; // drop empty messages

    out.push(line);
    if (line.type !== "assistant") continue;

    const ids = blocksOf(line)
      .filter((b) => b.type === "tool_use")
      .map((b) => b.id);
    if (ids.length === 0) continue;

    // Absorb the run of following tool-result-only user messages.
    const found = new Map<string, AnthropicBlock>();
    const controls: ClaudeTranscriptRecord[] = [];
    let firstResultLine: ClaudeTranscriptLine | null = null;
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j].type === "attachment") {
        controls.push(lines[j]);
        j++;
        continue;
      }
      if (!isPureToolResult(lines[j])) break;
      const resultLine = lines[j] as ClaudeTranscriptLine;
      firstResultLine ??= resultLine;
      for (const b of blocksOf(lines[j])) {
        if (b.type === "tool_result") found.set(b.tool_use_id, b);
      }
      j++;
    }

    // One user message answering every tool_use of this assistant turn, in order.
    const merged: AnthropicBlock[] = [];
    for (const id of ids) {
      merged.push(
        found.get(id) ?? {
          type: "tool_result",
          tool_use_id: id,
          content: MISSING_RESULT_TEXT,
          is_error: true,
        },
      );
      found.delete(id);
    }
    for (const leftover of found.values()) merged.push(leftover); // keep stray results

    const template = firstResultLine ?? line;
    const answer: ClaudeTranscriptLine = {
      ...template,
      type: "user",
      message: { role: "user", content: merged },
      uuid: randomUUID(),
    };
    delete answer.customTitle;
    if (merged.length !== 1 || firstResultLine == null) delete answer.toolUseResult;
    out.push(...controls);
    out.push(answer);

    i = j - 1;
  }

  // Safety net: a tool_result whose tool_use never appeared (compacted history,
  // an unmapped call variant) is rejected by the API. Keep the content, drop the
  // pairing by demoting it to text.
  const knownIds = new Set<string>();
  for (const line of out) {
    for (const b of blocksOf(line)) if (b.type === "tool_use") knownIds.add(b.id);
  }
  for (const line of out) {
    const blocks = blocksOf(line);
    if (!blocks.some((b) => b.type === "tool_result" && !knownIds.has(b.tool_use_id))) {
      continue;
    }
    if (line.type === "attachment") continue;
    line.message.content = blocks.map((b) =>
      b.type === "tool_result" && !knownIds.has(b.tool_use_id)
        ? { type: "text", text: `[tool result ${b.tool_use_id}]\n${b.content}` }
        : b,
    );
  }

  // A transcript must open with a user message.
  while (out.length > 0 && out[0].type === "assistant") out.shift();

  // Re-link the chain after merges and drops.
  let parent: string | null = null;
  for (const line of out) {
    line.parentUuid = parent;
    parent = line.uuid;
  }
  return out;
}

/**
 * Keep a transcript inside Claude's context window.
 *
 * Claude replays the whole transcript when a conversation is resumed, so a long
 * Codex session can exceed the limit before the first message is even sent
 * ("Prompt is too long"). Capping individual tool results is not always enough —
 * a session with thousands of tool calls still adds up — so the oldest turns are
 * dropped and replaced by a note saying so. Recent context is what a resumed
 * conversation actually needs.
 */
export interface TranscriptBudgetOptions {
  /** Number of terminal control records that must never be trimmed. */
  preserveSuffix?: number;
}

export function applyBudget(
  lines: ClaudeTranscriptLine[],
  maxChars?: number,
  options?: TranscriptBudgetOptions,
): { lines: ClaudeTranscriptLine[]; omitted: number };
export function applyBudget(
  lines: ClaudeTranscriptRecord[],
  maxChars?: number,
  options?: TranscriptBudgetOptions,
): { lines: ClaudeTranscriptRecord[]; omitted: number };
export function applyBudget(
  lines: ClaudeTranscriptRecord[],
  maxChars: number = DEFAULT_MAX_TRANSCRIPT_CHARS,
  options: TranscriptBudgetOptions = {},
): { lines: ClaudeTranscriptRecord[]; omitted: number } {
  if (maxChars <= 0 || lines.length === 0) return { lines, omitted: 0 };

  const sizes = lines.map((l) => JSON.stringify(l).length + 1);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= maxChars) return { lines, omitted: 0 };

  const preserveSuffix = options.preserveSuffix ?? 0;
  if (!Number.isInteger(preserveSuffix) || preserveSuffix < 0 || preserveSuffix > lines.length) {
    throw new Error("preserveSuffix must be an integer within the transcript length");
  }
  const historyEnd = lines.length - preserveSuffix;
  if (historyEnd === 0) {
    throw new Error(`required transcript controls exceed the ${maxChars}-character budget`);
  }

  // Walk back from the end, keeping as much recent history as fits.
  let used = sizes.slice(historyEnd).reduce((a, b) => a + b, 0);
  let start = historyEnd;
  for (let i = historyEnd - 1; i >= 0; i--) {
    if (used + sizes[i] > maxChars) break;
    used += sizes[i];
    start = i;
  }

  // The omission notice and tool repair can add bytes, so verify the exact
  // serialized candidate and trim additional old records until it fits.
  for (; start <= historyEnd; start++) {
    const kept = repairTranscript(lines.slice(start, historyEnd));
    const suffix = lines.slice(historyEnd);
    const template = kept[0] ?? suffix[0] ?? lines[lines.length - 1]!;
    const notice: ClaudeTranscriptLine = {
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      cwd: template.cwd,
      sessionId: template.sessionId,
      version: template.version,
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "text",
          text:
            `[codex-to-claude] ${start} earlier message(s) were omitted to fit the ` +
            `context window. The full history remains in the original Codex session.`,
        }],
      },
      uuid: randomUUID(),
      timestamp: template.timestamp,
      isMeta: true,
    };
    if (template.gitBranch) notice.gitBranch = template.gitBranch;
    if (template.type !== "attachment" && template.customTitle) {
      notice.customTitle = template.customTitle;
    }
    const out: ClaudeTranscriptRecord[] = [notice, ...kept, ...suffix];
    let parent: string | null = null;
    for (const line of out) {
      line.parentUuid = parent;
      parent = line.uuid;
    }
    if (out.reduce((sum, line) => sum + JSON.stringify(line).length + 1, 0) <= maxChars) {
      return { lines: out, omitted: start };
    }
  }
  throw new Error(`required transcript controls exceed the ${maxChars}-character budget`);
}

/**
 * Budget only what a resumed conversation actually replays.
 *
 * Claude loads a transcript from its last `compact_boundary`, so history before
 * that boundary never enters the prompt — Codex already compacted it away. It
 * costs nothing to resume and is the record of the conversation the user reads.
 * Trimming it to fit a prompt budget removes the conversation while keeping the
 * cost, so the budget applies to the active tail and the earlier history is
 * left whole. With no boundary the whole transcript is active, and this is the
 * plain budget.
 */
export function applyActiveBudget(
  lines: ClaudeTranscriptLine[],
  maxChars?: number,
  options?: TranscriptBudgetOptions,
): ClaudeTranscriptLine[];
export function applyActiveBudget(
  lines: ClaudeTranscriptRecord[],
  maxChars?: number,
  options?: TranscriptBudgetOptions,
): ClaudeTranscriptRecord[];
export function applyActiveBudget(
  lines: ClaudeTranscriptRecord[],
  maxChars?: number,
  options: TranscriptBudgetOptions = {},
): ClaudeTranscriptRecord[] {
  const lastBoundary = lines.findLastIndex(
    (line) => line.type === "system" && line.subtype === "compact_boundary",
  );
  if (lastBoundary < 0) return applyBudget(lines, maxChars, options).lines;

  const history = lines.slice(0, lastBoundary + 1);
  const active = applyBudget(lines.slice(lastBoundary + 1), maxChars, options).lines;
  const out = [...history, ...active];
  // The two halves were linked independently; rejoin them into one chain.
  let parent: string | null = null;
  for (const line of out) {
    line.parentUuid = parent;
    parent = line.uuid;
  }
  return out;
}
