import { createHash } from "node:crypto";

export interface LogicalMessage {
  role: "user" | "assistant" | "developer";
  text: string;
  timestamp?: string;
}

export interface HistoricalTaskCard {
  status: string;
  summary?: string;
  result?: string;
  taskId?: string;
  timestamp?: string;
}

export interface HistoricalGoalCard {
  goal?: string;
  status?: string;
  timestamp?: string;
}

export interface HistoricalAccessCard {
  permissionMode?: string;
  timestamp?: string;
}

export interface HistoricalContextCard {
  text: string;
  timestamp?: string;
}

export type LogicalCodexItem =
  | ({ kind: "message" } & LogicalMessage)
  | { kind: "tool_call"; callId: string; name: string; input: unknown; timestamp?: string }
  | { kind: "tool_result"; callId: string; output: unknown; timestamp?: string }
  | ({ kind: "historical_task" } & HistoricalTaskCard)
  | ({ kind: "historical_goal" } & HistoricalGoalCard)
  | ({ kind: "historical_access" } & HistoricalAccessCard)
  | ({ kind: "historical_context" } & HistoricalContextCard);

export interface LogicalCodexConversation {
  threadId: string;
  cwd: string;
  title: string;
  createdAt: string;
  sourceVersion?: string;
  messages: LogicalMessage[];
  /** Ordered semantic items. When absent, `messages` supplies the legacy view. */
  items?: LogicalCodexItem[];
  historicalTasks?: HistoricalTaskCard[];
  compaction?: {
    activeItemIndex?: number;
    /** Compatibility alias for callers that only carry messages. */
    activeMessageIndex?: number;
    preTokens?: number;
    postTokens?: number;
    summary?: string;
  };
}

export interface CodexRolloutLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Refuse malformed native tool history before it can enter a Codex rollout. */
export function assertLogicalToolHistory(items: readonly LogicalCodexItem[]): void {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool_call") {
      if (item.callId.trim() === "" || item.name.trim() === "" || !isPlainObject(item.input)) {
        throw new Error("native tool call requires a nonempty id/name and plain-object input");
      }
      if (calls.has(item.callId)) throw new Error(`duplicate native tool call id: ${item.callId}`);
      calls.add(item.callId);
    } else if (item.kind === "tool_result") {
      if (item.callId.trim() === "" || !calls.has(item.callId)) {
        throw new Error(`orphan native tool result: ${item.callId}`);
      }
      if (results.has(item.callId)) throw new Error(`duplicate native tool result: ${item.callId}`);
      results.add(item.callId);
    }
  }
  for (const callId of calls) {
    if (!results.has(callId)) throw new Error(`native tool call has no result: ${callId}`);
  }
}

function safeTaskText(task: HistoricalTaskCard): string {
  const lines = [
    "Imported historical task status — this is not a live task.",
    `Status: ${task.status || "unknown"}`,
  ];
  if (task.taskId) lines.push(`Task: ${task.taskId}`);
  if (task.summary) lines.push(`Summary: ${task.summary}`);
  if (task.result) lines.push(`Result: ${task.result}`);
  return lines.join("\n");
}

function safeGoalText(goal: HistoricalGoalCard): string {
  return [
    "Imported historical goal snapshot — this goal is not active.",
    `Status: ${goal.status || "unknown"}`,
    goal.goal ? `Goal: ${goal.goal}` : null,
  ].filter((line): line is string => line != null).join("\n");
}

function safeAccessText(access: HistoricalAccessCard): string {
  return [
    "Imported historical access snapshot — no permission was granted.",
    `Mode: ${access.permissionMode || "unknown"}`,
  ].join("\n");
}

function safeContextText(context: HistoricalContextCard): string {
  return [
    "Imported historical context — this is not an active instruction.",
    context.text,
  ].join("\n");
}

/**
 * Codex Desktop renders a conversation from the `event_msg` stream; `response_item`
 * records are the model-facing history it resumes from. A rollout carrying only
 * `response_item` lines is resumable but draws an empty transcript, so every
 * renderable message is emitted on both streams.
 */
function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The text a `message` response item carries, or null when it is not one. */
function renderableMessage(payload: Record<string, unknown>): { role: string; text: string } | null {
  if (payload.type !== "message" || typeof payload.role !== "string") return null;
  const content = payload.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!isPlainObject(first) || typeof first.text !== "string") return null;
  return { role: payload.role, text: first.text };
}

function responseItem(message: LogicalMessage): Record<string, unknown> {
  return {
    type: "message",
    role: message.role,
    content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.text }],
  };
}

function logicalItemPayload(item: LogicalCodexItem): Record<string, unknown> {
  if (item.kind === "message") return responseItem(item);
  if (item.kind === "historical_task") {
    return responseItem({ role: "assistant", text: safeTaskText(item) });
  }
  if (item.kind === "historical_goal") {
    return responseItem({ role: "assistant", text: safeGoalText(item) });
  }
  if (item.kind === "historical_access") {
    return responseItem({ role: "assistant", text: safeAccessText(item) });
  }
  if (item.kind === "historical_context") {
    return responseItem({ role: "assistant", text: safeContextText(item) });
  }
  if (item.kind === "tool_call") {
    return {
      type: "function_call",
      name: item.name || "external_tool",
      arguments: JSON.stringify(item.input ?? {}),
      call_id: item.callId,
    };
  }
  return {
    type: "function_call_output",
    call_id: item.callId,
    output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
  };
}

export function buildCodexRollout41059(input: LogicalCodexConversation): CodexRolloutLine[] {
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("invalid conversation creation timestamp");
  const lines: CodexRolloutLine[] = [{
    timestamp: input.createdAt,
    type: "session_meta",
    payload: {
      session_id: input.threadId,
      id: input.threadId,
      timestamp: input.createdAt,
      cwd: input.cwd,
      originator: "agentryx-session-import",
      cli_version: "0.146.0-alpha.3.1",
      source: "vscode",
      thread_source: "user",
      model_provider: "openai",
      history_mode: "legacy",
      native_session_id: input.threadId,
      import_provenance: {
        bridge: "agentryx.bridge/conversation-v1",
        source_version: input.sourceVersion ?? null,
      },
    },
  }];

  const logicalItems = input.items ?? input.messages.map((message): LogicalCodexItem => ({
    kind: "message",
    ...message,
  }));
  assertLogicalToolHistory(logicalItems);
  const items = logicalItems.map(logicalItemPayload);
  const activeIndex = input.compaction?.activeItemIndex ?? input.compaction?.activeMessageIndex;
  const compactedLine = (timestamp: string): CodexRolloutLine => {
    const replacement: Record<string, unknown>[] = [];
    if (input.compaction?.summary) {
      replacement.unshift(responseItem({ role: "user", text: input.compaction.summary }));
    }
    return {
      timestamp,
      type: "compacted",
      payload: {
        message: "Imported Claude compact boundary",
        replacement_history: replacement,
        bridge_compaction: {
          pre_tokens: input.compaction?.preTokens ?? null,
          post_tokens: input.compaction?.postTokens ?? null,
        },
      },
    };
  };
  // Native order, measured on 26.721.41059: a user turn writes its response_item
  // first and the `user_message` event after it; an assistant turn writes the
  // `agent_message` event first and the response_item after.
  const pushRendered = (
    timestamp: string, payload: Record<string, unknown>, seed: string,
  ): void => {
    const message = renderableMessage(payload);
    const item: CodexRolloutLine = { timestamp, type: "response_item", payload };
    if (message?.role === "user") {
      lines.push(item, {
        timestamp,
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: deterministicUuid(`${input.threadId}:user_message:${seed}`),
          message: message.text,
          images: [], local_images: [], audio: [], local_audio: [], text_elements: [],
        },
      });
      return;
    }
    if (message?.role === "assistant") {
      lines.push({
        timestamp,
        type: "event_msg",
        payload: {
          type: "agent_message", message: message.text,
          phase: "commentary", memory_citation: null,
        },
      }, item);
      return;
    }
    // Developer messages and native tool call/output items have no measured
    // event_msg form on this build; they stay model-facing only.
    lines.push(item);
  };

  if (input.compaction && activeIndex === 0) lines.push(compactedLine(input.createdAt));
  for (let i = 0; i < logicalItems.length; i += 1) {
    const item = logicalItems[i];
    const timestamp = item.timestamp && Number.isFinite(Date.parse(item.timestamp))
      ? new Date(item.timestamp).toISOString()
      : input.createdAt;
    pushRendered(timestamp, items[i]!, `item:${i}`);
    if (input.compaction && activeIndex != null && i + 1 === activeIndex) {
      // The replacement history is the context that exists *at the boundary*.
      // Messages after the boundary are appended below in normal file order.
      // Including them here as well would replay every active message twice.
      lines.push(compactedLine(timestamp));
    }
  }
  const tasks = input.historicalTasks ?? [];
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    pushRendered(
      task.timestamp ?? input.createdAt,
      responseItem({ role: "assistant", text: safeTaskText(task) }),
      `historical_task:${i}`,
    );
  }
  return lines;
}

export function serializeCodexRollout41059(lines: CodexRolloutLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length ? "\n" : "");
}

export function rolloutSha25641059(lines: CodexRolloutLine[]): string {
  return createHash("sha256").update(serializeCodexRollout41059(lines), "utf8").digest("hex");
}
