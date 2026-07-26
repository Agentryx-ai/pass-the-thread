// Validate a converted transcript against the constraints the Messages API
// enforces when a session is resumed. A transcript that violates these loads in
// the UI but fails on the next turn with a 400, so importing must guarantee them.
import { CLAUDE_GOAL_MAX_CONDITION_CHARS } from "./claude-goal-target.ts";
import type { AnthropicBlock, ClaudeTranscriptLine, ClaudeTranscriptRecord } from "./types.ts";

export interface ValidationIssue {
  line: number;
  kind: string;
  detail: string;
}

/** Blocks of a line, or [] when absent. */
function blocksOf(line: ClaudeTranscriptRecord): AnthropicBlock[] {
  if (line.type === "attachment") return [];
  const c = line.message?.content;
  if (typeof c === "string") return c === "" ? [] : [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

export function validateTranscript(lines: ClaudeTranscriptRecord[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenToolUseIds = new Set<string>();
  /** tool_use ids emitted by the previous assistant line and not yet resolved. */
  let pending: string[] = [];
  const uuids = new Set<string>();
  const sessionId = lines[0]?.sessionId;
  const cwd = lines[0]?.cwd;

  lines.forEach((line, i) => {
    const at = i + 1;
    if (line.sessionId === "" || line.sessionId !== sessionId) {
      issues.push({ line: at, kind: "session-identity", detail: "record sessionId differs from transcript" });
    }
    if (line.cwd !== cwd) {
      issues.push({ line: at, kind: "cwd-identity", detail: "record cwd differs from transcript" });
    }
    if (line.userType !== "external" || line.isSidechain !== false ||
      typeof line.version !== "string" || line.version === "") {
      issues.push({ line: at, kind: "record-metadata", detail: "invalid Claude transcript metadata" });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(line.uuid) ||
      uuids.has(line.uuid)) {
      issues.push({ line: at, kind: "record-uuid", detail: "record uuid must be a unique UUIDv4" });
    }
    uuids.add(line.uuid);
    const expectedParent = i === 0 ? null : lines[i - 1]!.uuid;
    if (line.parentUuid !== expectedParent) {
      issues.push({ line: at, kind: "parent-link", detail: "parentUuid must reference the previous record" });
    }
    if (!Number.isFinite(Date.parse(line.timestamp))) {
      issues.push({ line: at, kind: "timestamp", detail: "timestamp must be ISO-8601" });
    }
    if (line.type === "attachment") {
      const goal = line.attachment;
      if (line.entrypoint !== "claude-desktop" || goal?.type !== "goal_status" ||
        goal.met !== false || goal.sentinel !== true ||
        typeof goal.condition !== "string" || goal.condition.trim() === "" ||
        goal.condition.length > CLAUDE_GOAL_MAX_CONDITION_CHARS ||
        (goal as { failed?: unknown }).failed === true) {
        issues.push({ line: at, kind: "goal-attachment", detail: "malformed or contradictory goal_status attachment" });
      }
      return; // control records do not consume or interrupt pending tool adjacency
    }
    if (line.type === "system") return; // structural marker, no content
    const blocks = blocksOf(line);

    if (blocks.length === 0) {
      issues.push({ line: at, kind: "empty-content", detail: "message.content is empty" });
    }

    for (const b of blocks) {
      if (b.type === "text") {
        if (typeof b.text !== "string" || b.text === "") {
          issues.push({ line: at, kind: "empty-text", detail: "text block is empty" });
        }
      } else if (b.type === "tool_use") {
        if (typeof b.id !== "string" || b.id === "") {
          issues.push({ line: at, kind: "tool-use-id", detail: "tool_use.id missing" });
        }
        if (
          b.input === null ||
          typeof b.input !== "object" ||
          Array.isArray(b.input)
        ) {
          issues.push({
            line: at,
            kind: "tool-use-input",
            detail: `tool_use.input must be an object (got ${Array.isArray(b.input) ? "array" : typeof b.input})`,
          });
        }
        if (seenToolUseIds.has(b.id)) {
          issues.push({ line: at, kind: "duplicate-tool-use-id", detail: b.id });
        }
        seenToolUseIds.add(b.id);
      } else if (b.type === "tool_result") {
        if (!seenToolUseIds.has(b.tool_use_id)) {
          issues.push({
            line: at,
            kind: "orphan-tool-result",
            detail: `tool_result for unknown id ${b.tool_use_id}`,
          });
        }
      }
    }

    // Every tool_use must be answered by tool_result blocks in the next message.
    if (pending.length > 0) {
      const answered = new Set(
        blocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id),
      );
      const missing = pending.filter((id) => !answered.has(id));
      if (missing.length > 0) {
        issues.push({
          line: at,
          kind: "unanswered-tool-use",
          detail: `missing tool_result for ${missing.join(", ")}`,
        });
      }
    }
    pending =
      line.type === "assistant"
        ? blocks.filter((b) => b.type === "tool_use").map((b) => b.id)
        : [];
  });

  if (pending.length > 0) {
    issues.push({
      line: lines.length,
      kind: "unanswered-tool-use",
      detail: `transcript ends with unanswered ${pending.join(", ")}`,
    });
  }

  if (lines.length > 0 && lines[0].type === "assistant") {
    issues.push({ line: 1, kind: "leading-assistant", detail: "transcript must start with a user message" });
  }

  return issues;
}
