import { randomUUID } from "node:crypto";
import type {
  AnthropicBlock,
  ClaudeTranscriptLine,
  CodexSession,
} from "./types.ts";
import { splitUserMessage } from "./preamble.ts";
import { splitCitations } from "./citation.ts";
import { applyBudget, repairTranscript } from "./repair.ts";

export interface MapOptions {
  /** Value written to each line's `version` field. */
  version?: string;
  /** Include Codex `reasoning` items as Claude `thinking` blocks. Default false. */
  includeReasoning?: boolean;
  /** Prefix prepended to the conversation title (via customTitle on the first line). */
  titlePrefix?: string;
  /**
   * Cap on a single tool result, in characters. Tool output dominates a Codex
   * transcript (~50% of bytes here) while prose is a rounding error, and Claude
   * replays the whole transcript on resume — an uncapped import can exceed the
   * context window before the first message. Codex's own importer caps at 4000.
   */
  maxToolChars?: number;
  /** Ceiling on the whole transcript, in characters. 0 disables trimming. */
  maxChars?: number;
}

const DEFAULT_VERSION = "0.0.0-codex-import";
const DEFAULT_MAX_TOOL_CHARS = 4000;

function truncate(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  const dropped = text.length - limit;
  return `${text.slice(0, limit)}
… [truncated ${dropped} characters]`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n").trim();
}

/** Media types the Messages API accepts for an image block. */
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Codex stores pasted screenshots as `input_image` blocks holding a data URL.
 * Flattening a message to text would drop them, so convert to Claude image blocks.
 */
function imagesFromContent(content: unknown): AnthropicBlock[] {
  if (!Array.isArray(content)) return [];
  const out: AnthropicBlock[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if ((b as { type?: unknown }).type !== "input_image") continue;
    const url = (b as { image_url?: unknown }).image_url;
    if (typeof url !== "string") continue;
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (!m) continue; // remote URLs cannot be inlined
    const mediaType = m[1].toLowerCase();
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) continue;
    out.push({ type: "image", source: { type: "base64", media_type: mediaType, data: m[2] } });
  }
  return out;
}

function safeJsonParse(s: unknown): unknown {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * `tool_use.input` must be a JSON object — the Messages API rejects a string or
 * array with `tool_use.input: Input should be an object`, which makes an imported
 * session fail to resume. Codex stores `arguments` as a JSON string that is not
 * always an object (and is occasionally not valid JSON at all), so coerce here
 * while preserving the original payload.
 */
function toToolInput(raw: unknown, limit = DEFAULT_MAX_TOOL_CHARS): Record<string, unknown> {
  if (typeof raw === "string" && raw.length > limit * 4) {
    // An oversized argument blob (a whole patch, a pasted file) is not worth the
    // context it costs on replay.
    return { input: truncate(raw, limit * 4) };
  }
  const parsed = safeJsonParse(raw);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  if (parsed === null || parsed === undefined || parsed === "") return {};
  return { input: parsed };
}

function normalizeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const content = (output as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return textFromContent(content);
    return JSON.stringify(output);
  }
  return output == null ? "" : String(output);
}

function isErrorOutput(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    (output as { is_error?: unknown }).is_error === true
  );
}

/**
 * Convert a parsed Codex session into an ordered list of Claude Code transcript lines.
 * Inverse of Codex's bD/CD/BD pipeline (see DAU-025/DAU-026 and the design doc §3).
 */
export function mapSessionToClaudeLines(
  session: CodexSession,
  opts: MapOptions = {},
): ClaudeTranscriptLine[] {
  const version = opts.version ?? DEFAULT_VERSION;
  const includeReasoning = opts.includeReasoning ?? false;
  const maxToolChars = opts.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS;
  const gitBranch = session.meta.git?.branch;
  const model = session.model ?? undefined;

  let lines: ClaudeTranscriptLine[] = [];
  let parentUuid: string | null = null;
  /** First message the human actually typed — used for the display title. */
  let firstRealUserText = "";

  // Buffer that groups an assistant turn's blocks (thinking + text + tool_use)
  // into a single assistant message, matching Claude Code's turn shape.
  let assistantBuf: AnthropicBlock[] = [];
  let assistantTsMs: number | null = null;

  const isoOf = (tsMs: number | null): string =>
    new Date(tsMs ?? session.firstTsMs ?? session.lastTsMs ?? 0).toISOString();

  const emit = (
    type: "user" | "assistant",
    content: AnthropicBlock[],
    tsMs: number | null,
    extra?: { toolUseResult?: unknown; isMeta?: boolean },
  ): void => {
    const uuid = randomUUID();
    const line: ClaudeTranscriptLine = {
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd: session.cwd,
      sessionId: session.sessionId,
      version,
      type,
      message:
        type === "assistant"
          ? { role: "assistant", content, model }
          : { role: "user", content },
      uuid,
      timestamp: isoOf(tsMs),
    };
    if (gitBranch) line.gitBranch = gitBranch;
    if (extra?.isMeta) line.isMeta = true;
    if (extra?.toolUseResult !== undefined) line.toolUseResult = extra.toolUseResult;
    lines.push(line);
    parentUuid = uuid;
  };

  const flushAssistant = (): void => {
    if (assistantBuf.length === 0) return;
    emit("assistant", assistantBuf, assistantTsMs);
    assistantBuf = [];
    assistantTsMs = null;
  };

  for (const { tsMs, payload } of session.items) {
    const type = payload["type"];

    if (type === "message") {
      const role = payload["role"];
      const text = textFromContent(payload["content"]);
      if (role === "assistant") {
        // Codex appends its memory citations to the reply as text. Claude has no
        // citation form to map them onto, so they leave the message and become
        // metadata rather than sitting in the prose as raw tags.
        const { body, citations } = splitCitations(text);
        if (body !== "") {
          if (assistantTsMs == null) assistantTsMs = tsMs;
          assistantBuf.push({ type: "text", text: body });
        }
        if (citations.length > 0) {
          flushAssistant();
          for (const citation of citations) {
            emit("user", [{ type: "text", text: citation }], tsMs, { isMeta: true });
          }
        }
      } else {
        // user | developer | system -> user line.
        // Injected context (developer role, or a user message wrapped in a
        // structural tag) becomes isMeta so Claude keeps it in the transcript
        // but out of the conversation and out of title derivation.
        flushAssistant();
        if (text !== "") {
          // Some injections wrap the user's own message (attachment lists,
          // response annotations); split so the request survives as a real
          // message while the boilerplate becomes meta.
          const { meta, request } = splitUserMessage(String(role ?? "user"), text);
          const images = imagesFromContent(payload["content"]);
          if (meta != null) {
            emit(
              "user",
              [{ type: "text", text: meta }, ...(request == null ? images : [])],
              tsMs,
              { isMeta: true },
            );
          }
          if (request != null) {
            // attachments belong with what the user actually wrote
            emit("user", [{ type: "text", text: request }, ...images], tsMs);
            if (firstRealUserText === "") {
              firstRealUserText = request.replace(/\s+/g, " ").trim().slice(0, 100);
            }
          }
        }
      }
      continue;
    }

    // Claude's own compaction marker. When loading a transcript, Claude keeps
    // only what follows the last `compact_boundary`, so the full history can
    // stay on disk without being replayed into the context window.
    if (type === "__compact_boundary__") {
      flushAssistant();
      const uuid = randomUUID();
      lines.push({
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd: session.cwd,
        sessionId: session.sessionId,
        version,
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: {},
        message: { role: "user", content: [] },
        uuid,
        timestamp: isoOf(tsMs),
      } as ClaudeTranscriptLine);
      parentUuid = uuid;
      continue;
    }

    // Marks where Codex compacted: everything before it was replaced by the
    // summary Codex carried forward. That summary is encrypted in the rollout,
    // so only the boundary can be represented.
    if (type === "compaction") {
      flushAssistant();
      emit(
        "user",
        [
          {
            type: "text",
            text:
              "[pass-the-thread] Codex compacted the conversation here. Earlier turns " +
              "were replaced by a summary that is encrypted in the source session, so " +
              "only the messages Codex carried forward are present.",
          },
        ],
        tsMs,
        { isMeta: true },
      );
      continue;
    }

    // A sub-agent reporting back to the main thread. Real content (task results),
    // but authored by neither the user nor the main assistant, so it lands as
    // injected context. `encrypted_content` blocks carry no readable text and are
    // dropped by textFromContent.
    if (type === "agent_message") {
      const body = textFromContent(payload["content"]);
      if (body !== "") {
        flushAssistant();
        const from = String(payload["author"] ?? "agent");
        const to = String(payload["recipient"] ?? "/root");
        emit("user", [{ type: "text", text: `[agent ${from} → ${to}]\n${body}` }], tsMs, {
          isMeta: true,
        });
      }
      continue;
    }

    if (type === "reasoning") {
      if (!includeReasoning) continue;
      const summary = textFromContent(payload["summary"]);
      const body = textFromContent(payload["content"]);
      const thinking = [summary, body].filter((s) => s !== "").join("\n\n");
      if (thinking !== "") {
        if (assistantTsMs == null) assistantTsMs = tsMs;
        assistantBuf.push({ type: "thinking", thinking });
      }
      continue;
    }

    if (type === "function_call") {
      const callId = String(payload["call_id"] ?? randomUUID());
      if (assistantTsMs == null) assistantTsMs = tsMs;
      assistantBuf.push({
        type: "tool_use",
        id: callId,
        name: String(payload["name"] ?? "unknown"),
        input: toToolInput(payload["arguments"], maxToolChars),
      });
      continue;
    }

    // Result of a tool call. Codex has several shapes beyond function_call_output
    // (custom_tool_call_output, local_shell_call_output, ...); they all pair with
    // their call via call_id, so match structurally rather than by exact type.
    const isToolOutput =
      typeof payload["call_id"] === "string" &&
      (type === "function_call_output" ||
        String(type ?? "").endsWith("_output") ||
        "output" in payload);
    if (isToolOutput) {
      flushAssistant();
      const callId = String(payload["call_id"] ?? "");
      // Not every variant uses `output` (tool_search_output carries `tools`).
      const output =
        payload["output"] ?? payload["result"] ?? payload["tools"] ?? payload["content"];
      const full = normalizeOutput(output);
      const text = truncate(full !== "" ? full : `[${String(type ?? "tool output")}]`, maxToolChars);
      emit(
        "user",
        [
          {
            type: "tool_result",
            tool_use_id: callId,
            content: text,
            ...(isErrorOutput(output) ? { is_error: true } : {}),
          },
        ],
        tsMs,
        // toolUseResult repeats the payload for rendering; keep the capped copy
        // rather than a second full-size one.
        { toolUseResult: text },
      );
      continue;
    }

    // Remaining tool-call variants (custom_tool_call, tool_search_call,
    // local_shell_call, ...). Some carry no `name` (tool_search_call), so fall
    // back to the item type — every call still has to produce a tool_use, or its
    // output would be left without a matching call.
    const isToolCall =
      typeof payload["call_id"] === "string" &&
      (typeof payload["name"] === "string" || String(type ?? "").endsWith("_call"));
    if (isToolCall) {
      if (assistantTsMs == null) assistantTsMs = tsMs;
      assistantBuf.push({
        type: "tool_use",
        id: String(payload["call_id"]),
        name:
          typeof payload["name"] === "string" && payload["name"] !== ""
            ? payload["name"]
            : String(type ?? "tool").replace(/_call$/, ""),
        input: toToolInput(payload["arguments"] ?? payload["input"], maxToolChars),
      });
    }
  }

  flushAssistant();

  // Make the result replayable before anything reads lines[0].
  lines = repairTranscript(lines);
  lines = applyBudget(lines, opts.maxChars).lines;

  // Set a display title on the first line. Claude reads "customTitle" from the
  // file head with the highest priority, so this controls the sidebar label.
  //
  // The name Codex shows wins when it has one: a conversation the user knows as
  // "최신화하고 문서 읽기" should not arrive as the paragraph they opened with.
  // Codex only names threads started from the app, so CLI imports still fall
  // back to the first message the human typed — which is what Codex shows for
  // them too. Codex's injected preamble is never a title in either case.
  //
  // A Codex name is worth a customTitle on its own, without --title-prefix;
  // otherwise the name would be read off disk and then thrown away.
  const codexName = session.codexName?.trim();
  const prefix = opts.titlePrefix ?? "";
  if (lines.length > 0 && (prefix !== "" || (codexName != null && codexName !== ""))) {
    const base =
      codexName != null && codexName !== ""
        ? codexName
        : firstRealUserText !== ""
          ? firstRealUserText
          : session.title && session.title !== ""
            ? session.title
            : "(untitled)";
    lines[0].customTitle = (prefix + base).slice(0, 200);
  }

  return lines;
}
