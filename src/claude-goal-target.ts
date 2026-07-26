import { createHash } from "node:crypto";

import type { CanonicalGoalSnapshot, GoalMigrationMode } from "./goal.ts";
import type {
  ClaudeGoalAttachmentLine,
  ClaudeGoalDirectiveLine,
  ClaudeTranscriptLine,
  ClaudeTranscriptRecord,
  CodexSession,
} from "./types.ts";

export const CLAUDE_GOAL_TARGET_CAPABILITY_ID = "claude.goal-transcript/v1";
export const CLAUDE_GOAL_MAX_CONDITION_CHARS = 4000;
export const CLAUDE_GOAL_TARGET_FINGERPRINT = createHash("sha256").update(
  "claude.goal-transcript/v1\0attachment.goal_status\0historical-context\0isMeta-stop-directive\0max-condition:4000",
  "utf8",
).digest("hex");

export interface ClaudeGoalHistoryIdentity {
  mode: GoalMigrationMode;
  sourceGoalSha256: string | null;
  targetCapabilityId: string | null;
  targetFingerprint: string | null;
}

/** Normalize history identity to the Goal controls that actually affect output. */
export function claudeGoalHistoryIdentity(
  goal: CanonicalGoalSnapshot | null | undefined,
  requestedMode: GoalMigrationMode,
): ClaudeGoalHistoryIdentity {
  if (goal == null) {
    return {
      mode: "skip",
      sourceGoalSha256: null,
      targetCapabilityId: null,
      targetFingerprint: null,
    };
  }
  const activates = requestedMode === "migrate" && goal.migrationEligible;
  return {
    mode: activates ? "migrate" : "skip",
    sourceGoalSha256: goal.sourceSha256,
    targetCapabilityId: activates ? CLAUDE_GOAL_TARGET_CAPABILITY_ID : null,
    targetFingerprint: activates ? CLAUDE_GOAL_TARGET_FINGERPRINT : null,
  };
}

export function assertClaudeGoalCondition(condition: string): void {
  if (condition.trim() === "") throw new Error("Claude Goal condition must not be empty");
  if (condition.length > CLAUDE_GOAL_MAX_CONDITION_CHARS) {
    throw new Error(
      `Claude Goal condition is ${condition.length} characters; maximum is ${CLAUDE_GOAL_MAX_CONDITION_CHARS}`,
    );
  }
}

export function claudeGoalDirective(condition: string): string {
  assertClaudeGoalCondition(condition);
  return `A session-scoped Stop hook is now active with condition: "${condition}". ` +
    "Briefly acknowledge the goal, then immediately start (or continue) working toward it — " +
    "treat the condition itself as your directive and do not pause to ask the user what to do. " +
    "The hook will block stopping until the condition holds. It auto-clears once the condition is met — " +
    "do not tell the user to run `/goal clear` after success; that's only for clearing a goal early.";
}

function goalRecordUuid(goalSha256: string, kind: "history" | "directive" | "attachment"): string {
  const bytes = Buffer.from(createHash("sha256").update(`${goalSha256}\0${kind}`, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timestampFor(session: CodexSession, records: readonly ClaudeTranscriptRecord[]): string {
  const last = records.at(-1)?.timestamp;
  const parsed = last == null ? Number.NaN : Date.parse(last);
  return new Date(Number.isFinite(parsed) ? parsed : session.lastTsMs ?? session.firstTsMs ?? 0).toISOString();
}

function common(
  session: CodexSession,
  records: readonly ClaudeTranscriptRecord[],
): {
  parentUuid: string | null; isSidechain: false; userType: "external"; cwd: string;
  sessionId: string; version: string; timestamp: string;
} {
  const last = records.at(-1);
  return {
    parentUuid: last?.uuid ?? null,
    isSidechain: false as const,
    userType: "external",
    cwd: session.cwd,
    sessionId: session.sessionId,
    version: last?.version ?? "0.0.0-codex-import",
    timestamp: timestampFor(session, records),
  };
}

function historicalGoalLine(
  session: CodexSession,
  records: readonly ClaudeTranscriptRecord[],
  goal: CanonicalGoalSnapshot,
): ClaudeTranscriptLine {
  const line: ClaudeTranscriptLine = {
    ...common(session, records),
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "text",
        text: `[pass-the-thread] Historical source Goal (${goal.status}; not activated by this message):\n${goal.objective}`,
      }],
    },
    uuid: goalRecordUuid(goal.sourceSha256, "history"),
  };
  const gitBranch = session.meta.git?.branch;
  if (gitBranch) line.gitBranch = gitBranch;
  return line;
}

/** Add source Goal history and, only when eligible, Claude's native live controls. */
export function applyClaudeGoalTarget(
  session: CodexSession,
  input: readonly ClaudeTranscriptLine[],
  goal: CanonicalGoalSnapshot | null | undefined,
  mode: GoalMigrationMode = "migrate",
): ClaudeTranscriptRecord[] {
  const records: ClaudeTranscriptRecord[] = [...input];
  if (goal == null) return records;
  if (mode === "skip" || !goal.migrationEligible) {
    records.push(historicalGoalLine(session, records, goal));
    return records;
  }
  assertClaudeGoalCondition(goal.objective);

  const gitBranch = session.meta.git?.branch;
  const attachment: ClaudeGoalAttachmentLine = {
    ...common(session, records),
    type: "attachment",
    entrypoint: "claude-desktop",
    uuid: goalRecordUuid(goal.sourceSha256, "attachment"),
    attachment: { type: "goal_status", met: false, sentinel: true, condition: goal.objective },
  };
  if (gitBranch) attachment.gitBranch = gitBranch;
  records.push(attachment);
  records.push(historicalGoalLine(session, records, goal));

  const directive: ClaudeGoalDirectiveLine = {
    ...common(session, records),
    type: "user",
    message: { role: "user", content: claudeGoalDirective(goal.objective) },
    uuid: goalRecordUuid(goal.sourceSha256, "directive"),
    isMeta: true,
  };
  if (gitBranch) directive.gitBranch = gitBranch;
  records.push(directive);
  return records;
}

/** Claude's restart reducer: the last Goal attachment is authoritative. */
export function activeClaudeGoalFromRecords(records: readonly unknown[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record == null || typeof record !== "object") continue;
    const attachment = (record as { attachment?: unknown }).attachment;
    if (attachment == null || typeof attachment !== "object" ||
      (attachment as { type?: unknown }).type !== "goal_status") continue;
    const value = attachment as { met?: unknown; failed?: unknown; condition?: unknown };
    if (value.met === true || value.failed === true) return null;
    return typeof value.condition === "string" && value.condition !== "" ? value.condition : null;
  }
  return null;
}
