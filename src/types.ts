// Shared types for Codex rollout (source) and Claude Code transcript (target).
// See docs/FORMATS.md for the format contract.

import type { RenderMode } from "./render-mode.ts";

// ---------- Codex rollout (source) ----------

/** One line of a Codex rollout .jsonl file: RolloutLine wrapping a RolloutItem. */
export interface RolloutLine {
  timestamp?: string; // ISO-8601 UTC
  ordinal?: number;
  type: string; // session_meta | response_item | event_msg | turn_context | compacted | ...
  payload: unknown;
}

export interface CodexContentBlock {
  type: string; // input_text | output_text | text | summary_text | ...
  text?: string;
}

export interface CodexMessageItem {
  type: "message";
  role: "user" | "assistant" | "developer" | "system";
  content: CodexContentBlock[] | string;
}

export interface CodexReasoningItem {
  type: "reasoning";
  summary?: CodexContentBlock[];
  content?: CodexContentBlock[];
}

export interface CodexFunctionCallItem {
  type: "function_call";
  name: string;
  arguments: string; // JSON string
  call_id: string;
}

export interface CodexFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: unknown; // string, or { content: ... }
}

export interface SessionMeta {
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  model_provider?: string;
  instructions?: string;
  source?: unknown; // "cli" | {subagent:{...}} | ...
  parent_thread_id?: string | null;
  git?: { branch?: string; commit?: string; repository_url?: string } | null;
}

/** A parsed Codex session ready for filtering / conversion. */
export interface CodexSession {
  sessionId: string;
  /** Authoritative Codex Desktop thread id, when resolved from the thread index. */
  desktopThreadId?: string;
  rolloutPath: string;
  /** SHA-256 of the exact rollout bytes parsed into this snapshot. */
  sourceContentSha256?: string;
  cwd: string;
  /** cwd exactly as Codex recorded it (original case, \?\ prefix stripped). */
  cwdOriginal: string;
  meta: SessionMeta;
  firstTsMs: number | null;
  lastTsMs: number | null;
  /** response_item payloads in file order, plus the line timestamp. */
  items: Array<{ tsMs: number | null; payload: Record<string, unknown> }>;
  model: string | null;
  messageCount: number;
  title: string;
  /**
   * The name Codex generated for the conversation and shows in its sidebar,
   * when it has one. Absent for CLI threads, which Codex never names.
   */
  codexName?: string | null;
  /** Coarse source string from session_meta ("cli", "vscode", subagent JSON, ...). */
  source: string;
  /** True when this rollout is a spawned child (has parent_thread_id). */
  isChild: boolean;
  /** Codex Desktop project name this thread is assigned to (desktop-state selection only). */
  projectName?: string;
  /** Codex sandbox policy JSON, when known (thread index only). */
  sandboxPolicy?: string | null;
  /** Codex approval mode ("never", "on-request", ...), when known. */
  approvalMode?: string | null;
  /** Codex reasoning effort, when known. */
  reasoningEffort?: string | null;
  /** Assigned to a registered Codex Desktop project (vs. only reachable via Recents). */
  hasProject?: boolean;
  /** Archived in Codex. */
  isArchived?: boolean;
  /** Messages the human actually wrote (Codex's injected preamble excluded). */
  userMessageCount: number;
  /** Items Codex compacted away and that this import therefore does not carry. */
  compactedAway?: number;
}

// ---------- Claude Code transcript (target) ----------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
}
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export type AnthropicBlock =
  | AnthropicImageBlock
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

/** One line of a Claude Code transcript .jsonl file. */
export interface ClaudeTranscriptLine {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: "external";
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch?: string;
  type: "user" | "assistant" | "system";
  subtype?: string;
  /** Claude drops everything before the last compact boundary when loading. */
  compactMetadata?: { preservedSegment?: unknown };
  message: { role: "user" | "assistant"; content: AnthropicBlock[]; model?: string };
  uuid: string;
  timestamp: string; // ISO-8601 UTC
  toolUseResult?: unknown;
  /** Optional display title. Claude reads "customTitle" (highest priority) from the file head/tail. */
  customTitle?: string;
  /** Injected (non-user-authored) context. Claude excludes these from the conversation and from title derivation. */
  isMeta?: boolean;
  /** Marks a context-compaction summary. Claude excludes these from title derivation. */
  isCompactSummary?: boolean;
}

/** Native Claude Code transcript control record used to restore a live Goal. */
export interface ClaudeGoalAttachmentLine {
  parentUuid: string | null;
  isSidechain: false;
  userType: "external";
  entrypoint: "claude-desktop";
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch?: string;
  type: "attachment";
  uuid: string;
  timestamp: string;
  attachment: {
    type: "goal_status";
    met: false;
    sentinel: true;
    condition: string;
  };
}

/** Native Goal directive uses Claude's scalar user-content transcript shape. */
export interface ClaudeGoalDirectiveLine extends Omit<ClaudeTranscriptLine, "message" | "isMeta"> {
  type: "user";
  message: { role: "user"; content: string };
  isMeta: true;
}

export type ClaudeTranscriptRecord =
  | ClaudeTranscriptLine
  | ClaudeGoalDirectiveLine
  | ClaudeGoalAttachmentLine;

// ---------- Filtering ----------

export interface SessionFilter {
  sinceDays?: number; // default 30 (mirrors Codex maxSessionAgeMs=30d)
  max?: number; // default 50 (mirrors Codex maxSessions=50)
  project?: string; // substring match against cwd
  fromMs?: number; // inclusive lower bound on lastTs
  toMs?: number; // inclusive upper bound on lastTs
  id?: string; // exact sessionId
  /** Only conversations assigned to a Codex Desktop project. */
  projectsOnly?: boolean;
  /** Only conversations with no project (Codex shows these under Recents). */
  projectlessOnly?: boolean;
  /** Only archived conversations (requires archived to be fetched). */
  archivedOnly?: boolean;
  /** Keep conversations the user never wrote in. Codex hides these. */
  includeEmpty?: boolean;
}

// ---------- Import history (dedup) ----------

export interface ImportHistoryRecord {
  /** sha256 of the source rollout, for idempotent re-runs. */
  contentSha256: string;
  importedAtMs: number;
  importedSessionId: string;
  sourceRolloutPath: string;
  projectRoot: string;
  /** Target rendering used for this import. Missing on legacy records means semantic. */
  renderMode?: RenderMode;
  /** Missing on legacy records means skip: old imports never activated Goals. */
  goalMode?: import("./goal.ts").GoalMigrationMode;
  sourceGoalSha256?: string | null;
  targetGoalCapabilityId?: string | null;
  targetGoalFingerprint?: string | null;
  /** sha256 of the transcript this tool wrote, to detect later edits by Claude. */
  targetSha256?: string;
  /**
   * `sessionId` of every Claude Desktop session record this tool wrote for this
   * conversation — the record's own id, which is also its file name.
   *
   * Records are keyed by `cliSessionId` in the list, but Claude repoints that
   * field at a session of its own once the conversation is continued, and then
   * nothing identifies the record as ours. Remembering the id it was written
   * under is the only way to recognise it afterwards.
   */
  recordSessionIds?: string[];
}
export interface ImportHistory {
  version: 1;
  records: ImportHistoryRecord[];
}
