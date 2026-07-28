import fs from "node:fs";
import { createHash } from "node:crypto";

import { createEnvelope, deterministicId, type LineEnding, type RawEnvelope } from "./envelope.ts";
import {
  BRIDGE_IR_VERSION,
  HISTORICAL_SAFETY,
  type BridgeBundle,
  type BridgeEvent,
} from "./ir.ts";
import { splitUserMessage } from "./preamble.ts";
import { decodeCanonicalUtf8 } from "./render-mode.ts";
import type { CodexSession } from "./types.ts";
import {
  assertGoalSourceBinding,
  readCodexGoalSnapshot,
  type CanonicalGoalSnapshot,
} from "./goal.ts";

type ObjectRecord = Record<string, unknown>;

interface ExactLine {
  raw: string;
  lineEnding: LineEnding;
}

function splitExactLines(contents: string): ExactLine[] {
  const lines: ExactLine[] = [];
  let start = 0;
  while (start < contents.length) {
    const newline = contents.indexOf("\n", start);
    if (newline < 0) {
      lines.push({ raw: contents.slice(start), lineEnding: "" });
      break;
    }
    const carriageReturn = newline > start && contents[newline - 1] === "\r";
    lines.push({
      raw: contents.slice(start, carriageReturn ? newline - 1 : newline),
      lineEnding: carriageReturn ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

function asRecord(value: unknown): ObjectRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectRecord
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function base(envelope: RawEnvelope, path: string, kind: BridgeEvent["kind"]): {
  id: string;
  sourceEnvelopeId: string;
  path: string;
  timestamp: string | null;
  safety: typeof HISTORICAL_SAFETY;
} {
  const record = asRecord(envelope.parsed);
  return {
    id: deterministicId("bridge-event-v1", { envelopeId: envelope.id, path, kind }),
    sourceEnvelopeId: envelope.id,
    path,
    timestamp: stringOrNull(record?.timestamp),
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

function contentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((item) => {
    const block = asRecord(item);
    const text = stringOrNull(block?.text) ?? stringOrNull(block?.message);
    return text == null ? [] : [text];
  });
  return parts.length === 0 ? null : parts.join("\n");
}

function taskIdFrom(value: unknown): string | null {
  const record = asRecord(value);
  const explicit = stringOrNull(record?.task_id) ?? stringOrNull(record?.taskId);
  if (explicit) return explicit;
  const text = contentText(value) ?? contentText(record?.message) ?? contentText(record?.content);
  return text?.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/i)?.[1]?.trim() ?? null;
}

function containsTaskNotification(value: unknown): boolean {
  const record = asRecord(value);
  const text = contentText(value) ?? contentText(record?.message) ?? contentText(record?.content);
  return text != null && /<task-notification(?:\s|>)/i.test(text);
}

function goalValue(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  const record = asRecord(value);
  return stringOrNull(record?.objective) ?? stringOrNull(record?.goal);
}

function toolInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function textEvents(
  envelope: RawEnvelope,
  path: string,
  role: Extract<BridgeEvent, { kind: "text" }>["role"],
  text: string,
): BridgeEvent[] {
  if (containsTaskNotification(text)) {
    return [{
      ...base(envelope, path, "task_notification"),
      kind: "task_notification",
      taskId: taskIdFrom(text),
      content: text,
    }];
  }
  if (text === "") return [unknown(envelope, path, "unsupported_shape", text)];
  if (role !== "user") {
    return [{
      ...base(envelope, path, "text"),
      kind: "text",
      role,
      text,
      authoredByHuman: false,
    }];
  }
  const split = splitUserMessage("user", text);
  if (split.meta == null && split.request == null) {
    return [unknown(envelope, path, "unsupported_shape", text)];
  }
  if (split.meta == null && split.request != null) {
    return [{
      ...base(envelope, path, "text"),
      kind: "text",
      role: "user",
      text: split.request,
      authoredByHuman: true,
    }];
  }
  if (split.request == null) {
    return [{
      ...base(envelope, path, "text"),
      kind: "text",
      role: "system",
      text: split.meta!,
      authoredByHuman: false,
    }];
  }
  return [
    {
      ...base(envelope, `${path}.meta`, "text"),
      kind: "text",
      role: "system",
      text: split.meta!,
      authoredByHuman: false,
    },
    {
      ...base(envelope, `${path}.request`, "text"),
      kind: "text",
      role: "user",
      text: split.request,
      authoredByHuman: true,
    },
  ];
}

function messageEvents(envelope: RawEnvelope, payload: ObjectRecord): BridgeEvent[] {
  const content = payload.content;
  const roleValue = stringOrNull(payload.role) ?? "unknown";
  const role = roleValue === "user" || roleValue === "assistant" || roleValue === "system"
    ? roleValue
    : "unknown";
  if (typeof content === "string") {
    return textEvents(envelope, "payload.content", role, content);
  }
  if (!Array.isArray(content)) {
    return [unknown(envelope, "payload.content", "unsupported_shape", content)];
  }

  const events: BridgeEvent[] = [];
  content.forEach((value, index) => {
    const path = `payload.content[${index}]`;
    const block = asRecord(value);
    const blockType = stringOrNull(block?.type);
    if (!block || !blockType) {
      events.push(unknown(envelope, path, "unknown_content_block", value));
      return;
    }
    if ((blockType === "input_text" || blockType === "output_text" || blockType === "text") && typeof block.text === "string") {
      events.push(...textEvents(envelope, path, role, block.text));
      return;
    }
    if (blockType === "input_image" || blockType === "output_image" || blockType === "image") {
      events.push({
        ...base(envelope, path, "media"),
        kind: "media",
        mediaType: "image",
        source: block.image_url ?? block.url ?? block.source ?? null,
        metadata: block,
        role,
        authoredByHuman: role === "user" && blockType === "input_image",
      });
      return;
    }
    if (blockType === "input_audio" || blockType === "output_audio" || blockType === "audio") {
      events.push({
        ...base(envelope, path, "media"),
        kind: "media",
        mediaType: "audio",
        source: block.audio_url ?? block.url ?? block.source ?? null,
        metadata: block,
        role,
        authoredByHuman: role === "user" && blockType === "input_audio",
      });
      return;
    }
    events.push(unknown(envelope, path, "unknown_content_block", value));
  });
  if (events.length === 0) events.push(unknown(envelope, "payload.content", "unsupported_shape", content));
  return events;
}

function responseItemEvents(envelope: RawEnvelope, payload: ObjectRecord): BridgeEvent[] {
  const itemType = stringOrNull(payload.type);
  if (itemType === "message") return messageEvents(envelope, payload);
  if (itemType === "reasoning") {
    return [{
      ...base(envelope, "payload", "reasoning"),
      kind: "reasoning",
      summary: payload.summary ?? null,
      content: payload.content ?? null,
    }];
  }
  if (itemType === "compaction") {
    return [{
      ...base(envelope, "payload", "compact_boundary"),
      kind: "compact_boundary",
      compactMetadata: payload,
      activeContextStartsAfter: true,
    }];
  }
  if (itemType === "agent_message" && typeof payload.message === "string") {
    if (containsTaskNotification(payload.message)) {
      return [{
        ...base(envelope, "payload.message", "task_notification"),
        kind: "task_notification",
        taskId: taskIdFrom(payload.message),
        content: payload.message,
      }];
    }
    return [{
      ...base(envelope, "payload.message", "text"),
      kind: "text",
      role: "assistant",
      text: payload.message,
      authoredByHuman: false,
    }];
  }
  const callId = stringOrNull(payload.call_id);
  const isResult = callId != null && (
    itemType === "function_call_output" ||
    itemType?.endsWith("_output") === true ||
    "output" in payload
  );
  if (isResult) {
    return [{
      ...base(envelope, "payload", "tool_result"),
      kind: "tool_result",
      toolUseId: callId,
      content: payload.output ?? payload.result ?? payload.content ?? null,
      isError: typeof payload.is_error === "boolean" ? payload.is_error : null,
    }];
  }
  const isCall = callId != null && (
    itemType === "function_call" ||
    (itemType?.endsWith("_call") === true && (typeof payload.name === "string" || "arguments" in payload || "input" in payload))
  );
  if (isCall) {
    return [{
      ...base(envelope, "payload", "tool_use"),
      kind: "tool_use",
      toolUseId: callId,
      name: stringOrNull(payload.name) ?? itemType,
      input: toolInput(payload.arguments ?? payload.input ?? null),
    }];
  }
  return [unknown(envelope, "payload", "unknown_record", payload)];
}

function repathEvent(envelope: RawEnvelope, event: BridgeEvent, prefix: string): BridgeEvent {
  const path = event.path.replace(/^payload/, prefix);
  return {
    ...event,
    id: deterministicId("bridge-event-v1", { envelopeId: envelope.id, path, kind: event.kind }),
    path,
  };
}

function eventMessageEvents(envelope: RawEnvelope, payload: ObjectRecord): BridgeEvent[] {
  const protocolType = stringOrNull(payload.type);
  const events: BridgeEvent[] = [{
    ...base(envelope, "payload", "protocol"),
    kind: "protocol",
    recordType: "event_msg",
    protocolType,
    payload,
  }];
  if (containsTaskNotification(payload)) {
    events.push({
      ...base(envelope, "payload", "task_notification"),
      kind: "task_notification",
      taskId: taskIdFrom(payload),
      content: payload,
    });
    return events;
  }
  if (protocolType != null && /(?:^|_)goal(?:_|$)/i.test(protocolType)) {
    events.push({
      ...base(envelope, "payload", "goal_snapshot"),
      kind: "goal_snapshot",
      goal: goalValue(payload.goal) ?? goalValue(payload.objective),
      status: stringOrNull(payload.status),
      snapshot: payload,
    });
    return events;
  }
  return events;
}

/** Map one Codex rollout record. Every envelope produces at least one IR event. */
export function codexRecordToIr(envelope: RawEnvelope): BridgeEvent[] {
  const record = asRecord(envelope.parsed);
  if (!record) {
    return [unknown(envelope, "$", envelope.parseError ? "invalid_json" : "unsupported_shape", envelope.raw)];
  }
  const type = stringOrNull(record.type);
  const payload = asRecord(record.payload);
  if (type === "session_meta") {
    return [{
      ...base(envelope, "payload", "protocol"),
      kind: "protocol",
      recordType: type,
      protocolType: null,
      payload: record.payload ?? null,
    }];
  }
  if (type === "turn_context") {
    const context = record.payload ?? null;
    const events: BridgeEvent[] = [{
      ...base(envelope, "payload", "turn_context"),
      kind: "turn_context",
      context,
    }];
    if (payload && (payload.approval_policy !== undefined || payload.sandbox_policy !== undefined)) {
      events.push({
        ...base(envelope, "payload", "access_snapshot"),
        kind: "access_snapshot",
        permissionMode: stringOrNull(payload.approval_policy),
        snapshot: {
          approvalPolicy: payload.approval_policy ?? null,
          sandboxPolicy: payload.sandbox_policy ?? null,
        },
      });
    }
    return events;
  }
  if (type === "world_state") {
    return [{
      ...base(envelope, "payload", "world_state"),
      kind: "world_state",
      state: record.payload ?? record,
    }];
  }
  if (type === "compacted") {
    const events: BridgeEvent[] = [{
      ...base(envelope, "payload", "compact_boundary"),
      kind: "compact_boundary",
      compactMetadata: record.payload ?? record,
      activeContextStartsAfter: true,
    }];
    const replacement = payload?.replacement_history;
    if (Array.isArray(replacement)) replacement.forEach((value, index) => {
      const item = asRecord(value);
      const prefix = `payload.replacement_history[${index}]`;
      if (!item) {
        events.push(unknown(envelope, prefix, "unsupported_shape", value));
      } else if (item.type === "compaction") {
        events.push({
          ...base(envelope, prefix, "protocol"), kind: "protocol",
          recordType: "compacted_replacement", protocolType: "compaction", payload: item,
        });
      } else {
        events.push(...responseItemEvents(envelope, item).map((event) => repathEvent(envelope, event, prefix)));
      }
    });
    return events;
  }
  if (type === "event_msg" && payload) return eventMessageEvents(envelope, payload);
  if (type === "response_item" && payload) return responseItemEvents(envelope, payload);
  return [unknown(envelope, "$", "unknown_record", record)];
}

/** Build the provider-neutral canonical sidecar for a Codex source rollout. */
export function codexRolloutToBridgeBundle(
  session: CodexSession,
  goalState: CanonicalGoalSnapshot | null = null,
): BridgeBundle {
  const sourceThreadId = session.desktopThreadId ?? session.sessionId;
  if (goalState != null) {
    assertGoalSourceBinding(goalState, {
      provider: "codex",
      authority: "native-store",
      sourceThreadId,
    });
  }
  const bytes = fs.readFileSync(session.rolloutPath);
  let contents: string;
  try {
    contents = decodeCanonicalUtf8(bytes);
  } catch {
    throw new Error(`Codex rollout is not valid UTF-8: ${session.rolloutPath}`);
  }
  const envelopes = splitExactLines(contents).map((line, recordIndex) => createEnvelope("codex", line.raw, {
    sourcePath: session.rolloutPath,
    recordIndex,
    lineEnding: line.lineEnding,
  }));
  const sourceContentSha256 = createHash("sha256").update(bytes).digest("hex");
  if (session.sourceContentSha256 != null && session.sourceContentSha256 !== sourceContentSha256) {
    throw new Error(`Codex rollout changed after it was parsed: ${session.rolloutPath}`);
  }
  return {
    envelopes,
    conversation: {
      version: BRIDGE_IR_VERSION,
      id: session.sessionId || deterministicId("codex-conversation-v1", session.rolloutPath),
      source: "codex-rollout",
      sourceProvider: "codex",
      sourcePath: session.rolloutPath,
      sourceContentSha256,
      sourceSessionId: session.sessionId || null,
      sourceThreadId,
      cwd: session.cwdOriginal || session.cwd || null,
      title: session.codexName || session.title || null,
      ...(goalState == null ? {} : { goalState }),
      recordEnvelopeIds: envelopes.map((envelope) => envelope.id),
      events: envelopes.flatMap(codexRecordToIr),
    },
  };
}

/** Join a rollout snapshot to Codex's read-only authoritative Goal store. */
export function codexRolloutWithGoalToBridgeBundle(
  session: CodexSession,
  codexHome: string,
): BridgeBundle {
  const sourceThreadId = session.desktopThreadId ?? session.sessionId;
  return codexRolloutToBridgeBundle(session, readCodexGoalSnapshot(codexHome, sourceThreadId));
}
