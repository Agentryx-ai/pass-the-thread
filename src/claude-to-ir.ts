import { deterministicId, type RawEnvelope } from "./envelope.ts";
import {
  BRIDGE_IR_VERSION,
  HISTORICAL_SAFETY,
  type AccessSnapshotEvent,
  type BridgeBundle,
  type BridgeEvent,
} from "./ir.ts";
import type { ClaudeSourceTranscript } from "./claude-source.ts";

type ObjectRecord = Record<string, unknown>;

function asRecord(value: unknown): ObjectRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectRecord
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function timestampOf(record: ObjectRecord | null): string | null {
  return stringOrNull(record?.timestamp);
}

function base(envelope: RawEnvelope, path: string, kind: BridgeEvent["kind"]): {
  id: string;
  sourceEnvelopeId: string;
  path: string;
  timestamp: string | null;
  safety: typeof HISTORICAL_SAFETY;
} {
  return {
    id: deterministicId("bridge-event-v1", { envelopeId: envelope.id, path, kind }),
    sourceEnvelopeId: envelope.id,
    path,
    timestamp: timestampOf(asRecord(envelope.parsed)),
    safety: HISTORICAL_SAFETY,
  };
}

function unknown(
  envelope: RawEnvelope,
  path: string,
  reason: Extract<BridgeEvent, { kind: "unknown" }>["reason"],
  value: unknown,
): BridgeEvent {
  return { ...base(envelope, path, "unknown"), kind: "unknown", reason, value };
}

function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => asRecord(block))
    .filter((block): block is ObjectRecord => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  return text === "" ? null : text;
}

function taskIdFrom(content: unknown, record: ObjectRecord): string | null {
  const explicit = stringOrNull(record.taskId) ?? stringOrNull(record.task_id);
  if (explicit) return explicit;
  const text = contentText(content);
  return text?.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/i)?.[1]?.trim() ?? null;
}

function goalFrom(content: unknown, record: ObjectRecord): {
  goal: string | null;
  status: string | null;
} | null {
  const explicitGoal = stringOrNull(record.goal) ?? stringOrNull(record.objective);
  if (explicitGoal) return { goal: explicitGoal, status: stringOrNull(record.status) };
  const text = contentText(content);
  if (!text || !text.startsWith("<local-command-stdout>")) return null;
  const match = text.match(/Goal\s+(set|updated|completed|cleared)\s*:\s*([\s\S]*?)(?:<\/local-command-stdout>|$)/i);
  if (!match) return null;
  return {
    status: match[1].toLowerCase(),
    goal: match[2].trim() || null,
  };
}

function accessSnapshot(envelope: RawEnvelope, record: ObjectRecord): AccessSnapshotEvent | null {
  const kind = stringOrNull(record.type);
  const isExplicit =
    kind === "access" ||
    kind === "access_snapshot" ||
    kind === "access-snapshot" ||
    kind === "permission_snapshot" ||
    kind === "permission-snapshot";
  const permissionMode = stringOrNull(record.permissionMode) ?? stringOrNull(record.permission_mode);
  if (!isExplicit && permissionMode == null) return null;
  const snapshot = isExplicit
    ? (record.snapshot ?? record.access ?? record)
    : { permissionMode, cwd: record.cwd ?? null };
  return {
    ...base(envelope, "$", "access_snapshot"),
    kind: "access_snapshot",
    permissionMode,
    snapshot,
  };
}

function messageEvents(envelope: RawEnvelope, record: ObjectRecord): BridgeEvent[] {
  const message = asRecord(record.message);
  if (!message || !("content" in message)) {
    return [unknown(envelope, "$", "unsupported_shape", record)];
  }
  const roleValue = stringOrNull(message.role) ?? stringOrNull(record.type) ?? "unknown";
  const role = roleValue === "user" || roleValue === "assistant" || roleValue === "system"
    ? roleValue
    : "unknown";
  const origin = asRecord(record.origin);
  const authoredByHuman =
    role === "user" &&
    record.isMeta !== true &&
    record.toolUseResult === undefined &&
    record.isCompactSummary !== true &&
    !contentText(message.content)?.startsWith("<local-command-stdout>") &&
    (origin?.kind === undefined || origin.kind === "human");
  const content = message.content;

  if (record.toolUseResult !== undefined && !Array.isArray(content)) {
    const text = typeof content === "string" ? content : null;
    const toolUseId = text?.match(/\[tool result\s+([^\]]+)\]/i)?.[1] ?? null;
    return [{
      ...base(envelope, "message.content", "tool_result"),
      kind: "tool_result",
      toolUseId,
      content,
      isError: null,
      displayResult: record.toolUseResult,
    }];
  }

  if (typeof content === "string") {
    if (content === "") return [unknown(envelope, "message.content", "unsupported_shape", content)];
    return [{
      ...base(envelope, "message.content", "text"),
      kind: "text",
      role,
      text: content,
      authoredByHuman,
    }];
  }
  if (!Array.isArray(content)) {
    return [unknown(envelope, "message.content", "unsupported_shape", content)];
  }

  const events: BridgeEvent[] = [];
  content.forEach((value, index) => {
    const path = `message.content[${index}]`;
    const block = asRecord(value);
    if (!block || typeof block.type !== "string") {
      events.push(unknown(envelope, path, "unknown_content_block", value));
      return;
    }
    if (block.type === "text" && typeof block.text === "string") {
      events.push({
        ...base(envelope, path, "text"),
        kind: "text",
        role,
        text: block.text,
        authoredByHuman,
      });
      return;
    }
    if (block.type === "tool_use") {
      events.push({
        ...base(envelope, path, "tool_use"),
        kind: "tool_use",
        toolUseId: stringOrNull(block.id),
        name: stringOrNull(block.name),
        input: block.input ?? null,
      });
      return;
    }
    if (block.type === "tool_result") {
      const event: Extract<BridgeEvent, { kind: "tool_result" }> = {
        ...base(envelope, path, "tool_result"),
        kind: "tool_result",
        toolUseId: stringOrNull(block.tool_use_id),
        content: block.content ?? null,
        isError: typeof block.is_error === "boolean" ? block.is_error : null,
      };
      if (record.toolUseResult !== undefined) event.displayResult = record.toolUseResult;
      events.push(event);
      return;
    }
    if (block.type === "compaction") {
      events.push({
        ...base(envelope, path, "compact_boundary"),
        kind: "compact_boundary",
        compactMetadata: block,
        activeContextStartsAfter: true,
      });
      return;
    }
    events.push(unknown(envelope, path, "unknown_content_block", value));
  });
  if (events.length === 0) events.push(unknown(envelope, "message.content", "unsupported_shape", content));
  return events;
}

/** Map one raw source record. Every envelope produces at least one IR event. */
export function claudeRecordToIr(envelope: RawEnvelope): BridgeEvent[] {
  const record = asRecord(envelope.parsed);
  if (!record) {
    return [unknown(envelope, "$", envelope.parseError ? "invalid_json" : "unsupported_shape", envelope.raw)];
  }

  const events: BridgeEvent[] = [];
  const access = accessSnapshot(envelope, record);
  if (access) events.push(access);

  const type = stringOrNull(record.type);
  const origin = asRecord(record.origin);
  const message = asRecord(record.message);
  const content = message?.content;

  if (origin?.kind === "task-notification" || type === "task-notification" || type === "task_notification") {
    events.push({
      ...base(envelope, "$", "task_notification"),
      kind: "task_notification",
      taskId: taskIdFrom(content ?? record.content, record),
      content: content ?? record.content ?? null,
    });
    return events;
  }

  if (
    (type === "system" && record.subtype === "compact_boundary") ||
    type === "compact_boundary" ||
    type === "compact-boundary" ||
    record.isCompactSummary === true
  ) {
    events.push({
      ...base(envelope, "$", "compact_boundary"),
      kind: "compact_boundary",
      compactMetadata: record.compactMetadata ?? record,
      activeContextStartsAfter:
        record.subtype === "compact_boundary" || type === "compact_boundary" || type === "compact-boundary",
    });
    return events;
  }

  const explicitGoal = type === "goal" || type === "goal_snapshot" || type === "goal-snapshot";
  const goal = explicitGoal
    ? (goalFrom(content ?? record.content, record) ?? {
        goal: null,
        status: stringOrNull(record.status),
      })
    : type === "user"
      ? goalFrom(content ?? record.content, record)
      : null;
  if (goal) {
    events.push({
      ...base(envelope, "$", "goal_snapshot"),
      kind: "goal_snapshot",
      goal: goal.goal,
      status: goal.status,
      snapshot: explicitGoal ? (record.snapshot ?? record) : (content ?? record.content),
    });
    return events;
  }

  if (type === "user" || type === "assistant" || (type === "system" && message != null)) {
    events.push(...messageEvents(envelope, record));
    return events;
  }

  if (access && events.length > 0) return events;
  events.push(unknown(envelope, "$", "unknown_record", record));
  return events;
}

export function claudeTranscriptToIr(source: ClaudeSourceTranscript): BridgeBundle {
  const sourceSessionId = source.sessionId;
  const id = sourceSessionId ?? deterministicId("claude-conversation-v1", source.sourcePath);
  return {
    conversation: {
      version: BRIDGE_IR_VERSION,
      id,
      source: "claude",
      sourcePath: source.sourcePath,
      sourceContentSha256: source.contentSha256,
      sourceSessionId,
      cwd: source.cwd,
      title: source.title,
      recordEnvelopeIds: source.records.map((record) => record.id),
      events: source.records.flatMap(claudeRecordToIr),
    },
    envelopes: source.records,
  };
}


