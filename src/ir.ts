import type { RawEnvelope } from "./envelope.ts";
import type { CanonicalGoalSnapshot } from "./goal.ts";

export const BRIDGE_IR_VERSION = 2 as const;

/**
 * Imported control records describe past state. They are never instructions to
 * execute a tool, resume a task, activate a goal, or grant permissions.
 */
export interface HistoricalSafety {
  historical: true;
  execute: false;
  resumeTask: false;
  activateGoal: false;
  applyAccess: false;
}

export const HISTORICAL_SAFETY: HistoricalSafety = Object.freeze({
  historical: true,
  execute: false,
  resumeTask: false,
  activateGoal: false,
  applyAccess: false,
});

interface BridgeEventBase {
  id: string;
  sourceEnvelopeId: string;
  /** JSON path within the raw source record, when the event is one nested block. */
  path: string;
  timestamp: string | null;
  safety: HistoricalSafety;
}

export interface TextEvent extends BridgeEventBase {
  kind: "text";
  role: "user" | "assistant" | "system" | "unknown";
  text: string;
  authoredByHuman: boolean;
}

export interface ToolUseEvent extends BridgeEventBase {
  kind: "tool_use";
  toolUseId: string | null;
  name: string | null;
  input: unknown;
}

export interface ToolResultEvent extends BridgeEventBase {
  kind: "tool_result";
  toolUseId: string | null;
  content: unknown;
  isError: boolean | null;
  /** Claude's renderer payload, when present outside the content block. */
  displayResult?: unknown;
}

export interface TaskNotificationEvent extends BridgeEventBase {
  kind: "task_notification";
  taskId: string | null;
  content: unknown;
}

export interface CompactBoundaryEvent extends BridgeEventBase {
  kind: "compact_boundary";
  compactMetadata: unknown;
  /** True for a structural boundary after which Claude rebuilds active context. */
  activeContextStartsAfter: boolean;
}

export interface GoalSnapshotEvent extends BridgeEventBase {
  kind: "goal_snapshot";
  goal: string | null;
  status: string | null;
  snapshot: unknown;
}

export interface AccessSnapshotEvent extends BridgeEventBase {
  kind: "access_snapshot";
  permissionMode: string | null;
  snapshot: unknown;
}

export interface ReasoningEvent extends BridgeEventBase {
  kind: "reasoning";
  summary: unknown;
  content: unknown;
}

export interface MediaEvent extends BridgeEventBase {
  kind: "media";
  mediaType: "image" | "audio" | "file" | "unknown";
  source: unknown;
  metadata: unknown;
}

/** A known provider protocol record which has no portable behavioral meaning. */
export interface ProtocolEvent extends BridgeEventBase {
  kind: "protocol";
  recordType: string;
  protocolType: string | null;
  payload: unknown;
}

export interface TurnContextEvent extends BridgeEventBase {
  kind: "turn_context";
  context: unknown;
}

export interface WorldStateEvent extends BridgeEventBase {
  kind: "world_state";
  state: unknown;
}

export interface UnknownEvent extends BridgeEventBase {
  kind: "unknown";
  reason: "invalid_json" | "unknown_record" | "unknown_content_block" | "unsupported_shape";
  value: unknown;
}

export type BridgeEvent =
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | TaskNotificationEvent
  | CompactBoundaryEvent
  | GoalSnapshotEvent
  | AccessSnapshotEvent
  | ReasoningEvent
  | MediaEvent
  | ProtocolEvent
  | TurnContextEvent
  | WorldStateEvent
  | UnknownEvent;

export interface BridgeConversation {
  version: typeof BRIDGE_IR_VERSION;
  id: string;
  /** Open provider/format identifier; provider-specific parsing lives in adapters. */
  source: string;
  /** Provider identity when `source` names a provider-specific file format. */
  sourceProvider?: string;
  sourcePath: string;
  sourceContentSha256: string;
  sourceSessionId: string | null;
  /** Provider-native thread identity used to bind live control state. */
  sourceThreadId?: string | null;
  cwd: string | null;
  title: string | null;
  /** Authoritative current source Goal, separate from historical Goal events. */
  goalState?: CanonicalGoalSnapshot;
  recordEnvelopeIds: string[];
  events: BridgeEvent[];
}

/** An in-memory lossless unit. The store writes envelopes as content objects. */
export interface BridgeBundle {
  conversation: BridgeConversation;
  envelopes: RawEnvelope[];
}

export interface BridgeOperation {
  version: 1;
  id: string;
  kind: "store_conversation";
  conversationId: string;
  conversationSha256: string;
  status: "completed" | "failed";
  error?: string;
}


