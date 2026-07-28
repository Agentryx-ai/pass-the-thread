import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sha256Utf8, stableStringify } from "./envelope.ts";

export type GoalAuthority = "native-store" | "native-transcript";
export type GoalLifecycleStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete"
  | "failed";
export type GoalMigrationMode = "migrate" | "skip";
export type GoalMigrationEligibility = "eligible" | "ineligible" | "absent";
export type GoalMigrationDecisionStatus =
  | "ready_for_activation"
  | "pending_target_implementation"
  | "skipped_by_policy"
  | "historical_only"
  | "no_source_goal";

/** A deterministic plan-time decision. This unit never assigns a target Goal. */
export interface GoalMigrationDecision {
  mode: GoalMigrationMode;
  sourceGoalSha256: string | null;
  eligibility: GoalMigrationEligibility;
  sourceStatus: GoalLifecycleStatus | null;
  status: GoalMigrationDecisionStatus;
  targetCapabilityId: string | null;
  targetGoalId: string | null;
}

export interface GoalSourceLocator {
  sourcePath: string;
  recordIndex: number | null;
  table: string | null;
  key: string | null;
}

export interface CanonicalGoalSnapshot {
  version: 1;
  authority: GoalAuthority;
  provider: string;
  sourceThreadId: string;
  sourceGoalId: string | null;
  objective: string;
  status: GoalLifecycleStatus;
  migrationEligible: boolean;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  locator: GoalSourceLocator;
  sourceSha256: string;
}

export interface CanonicalGoalInput extends Omit<CanonicalGoalSnapshot, "version" | "migrationEligible" | "sourceSha256"> {
  /** Exact provider record or normalized native-store row used as the hash source. */
  sourceMaterial?: unknown;
  /** Hash of exact source record bytes when an envelope already computed it. */
  exactSourceSha256?: string;
}

const GOAL_STATUSES = new Set<GoalLifecycleStatus>([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
  "failed",
]);
const CODEX_GOAL_STATUSES = new Set<GoalLifecycleStatus>([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
]);
const SNAPSHOT_FIELDS = [
  "version",
  "authority",
  "provider",
  "sourceThreadId",
  "sourceGoalId",
  "objective",
  "status",
  "migrationEligible",
  "tokenBudget",
  "tokensUsed",
  "timeUsedSeconds",
  "createdAtMs",
  "updatedAtMs",
  "locator",
  "sourceSha256",
] as const;
const INTEGER_FIELDS = [
  "tokenBudget",
  "tokensUsed",
  "timeUsedSeconds",
  "createdAtMs",
  "updatedAtMs",
] as const;

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid canonical Goal ${field}: expected a non-empty string`);
  }
}

function integerOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid canonical Goal ${field}: expected a non-negative integer or null`);
  }
  return value;
}

function stringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  assertNonEmpty(value, field);
  return value;
}

function assertOwn(record: object, field: PropertyKey, owner = "canonical Goal snapshot"): void {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    throw new Error(`Invalid ${owner}: missing ${String(field)}`);
  }
}

export function parseGoalMigrationMode(value?: unknown): GoalMigrationMode {
  if (value == null || value === "") return "migrate";
  if (value === "migrate" || value === "skip") return value;
  throw new Error(`Invalid Goal migration mode: ${String(value)} (expected migrate or skip)`);
}

export function planGoalMigration(
  goal: CanonicalGoalSnapshot | null | undefined,
  mode: GoalMigrationMode = "migrate",
  targetCapabilityId: string | null = null,
): GoalMigrationDecision {
  const parsedMode = parseGoalMigrationMode(mode);
  if (goal == null) {
    const decision: GoalMigrationDecision = {
      mode: parsedMode,
      sourceGoalSha256: null,
      eligibility: "absent",
      sourceStatus: null,
      status: "no_source_goal",
      targetCapabilityId: null,
      targetGoalId: null,
    };
    validateGoalMigrationDecision(decision);
    return decision;
  }
  validateCanonicalGoalSnapshot(goal);
  const decision: GoalMigrationDecision = {
    mode: parsedMode,
    sourceGoalSha256: goal.sourceSha256,
    eligibility: goal.migrationEligible ? "eligible" : "ineligible",
    sourceStatus: goal.status,
    status: parsedMode === "skip"
      ? "skipped_by_policy"
      : goal.migrationEligible
        ? targetCapabilityId == null ? "pending_target_implementation" : "ready_for_activation"
        : "historical_only",
    targetCapabilityId: goal.migrationEligible && parsedMode === "migrate" ? targetCapabilityId : null,
    targetGoalId: null,
  };
  validateGoalMigrationDecision(decision);
  return decision;
}

export function validateGoalMigrationDecision(value: unknown): asserts value is GoalMigrationDecision {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Goal migration decision: expected an object");
  }
  const decision = value as Partial<GoalMigrationDecision>;
  if (decision.mode !== "migrate" && decision.mode !== "skip") {
    throw new Error(`Invalid Goal migration mode: ${String(decision.mode)} (expected migrate or skip)`);
  }
  const mode = parseGoalMigrationMode(decision.mode);
  if (!new Set(["eligible", "ineligible", "absent"]).has(String(decision.eligibility))) {
    throw new Error(`Invalid Goal migration eligibility: ${String(decision.eligibility)}`);
  }
  const statuses = new Set<GoalMigrationDecisionStatus>([
    "ready_for_activation", "pending_target_implementation", "skipped_by_policy", "historical_only", "no_source_goal",
  ]);
  if (!statuses.has(decision.status as GoalMigrationDecisionStatus)) {
    throw new Error(`Invalid Goal migration decision status: ${String(decision.status)}`);
  }
  if (decision.targetCapabilityId !== null &&
    (typeof decision.targetCapabilityId !== "string" || decision.targetCapabilityId === "")) {
    throw new Error("Invalid Goal migration target capability");
  }
  if (decision.targetGoalId !== null) {
    throw new Error("Invalid Goal migration target Goal id");
  }
  if (decision.eligibility === "absent") {
    if (decision.sourceGoalSha256 !== null || decision.sourceStatus !== null || decision.status !== "no_source_goal") {
      throw new Error("Invalid absent Goal migration decision");
    }
    return;
  }
  if (typeof decision.sourceGoalSha256 !== "string" || !/^[0-9a-f]{64}$/.test(decision.sourceGoalSha256)) {
    throw new Error("Invalid Goal migration sourceGoalSha256");
  }
  if (!GOAL_STATUSES.has(decision.sourceStatus as GoalLifecycleStatus)) {
    throw new Error(`Invalid Goal migration source status: ${String(decision.sourceStatus)}`);
  }
  if ((decision.sourceStatus === "active") !== (decision.eligibility === "eligible")) {
    throw new Error("Invalid Goal migration status eligibility");
  }
  const expected = mode === "skip"
    ? "skipped_by_policy"
    : decision.eligibility === "eligible"
      ? decision.targetCapabilityId == null ? "pending_target_implementation" : "ready_for_activation"
      : "historical_only";
  if (decision.status !== expected) throw new Error("Invalid Goal migration policy decision");
}

export function createCanonicalGoalSnapshot(input: CanonicalGoalInput): CanonicalGoalSnapshot {
  assertNonEmpty(input.provider, "provider");
  assertNonEmpty(input.sourceThreadId, "sourceThreadId");
  assertNonEmpty(input.objective, "objective");
  if (!GOAL_STATUSES.has(input.status)) {
    throw new Error(`Invalid canonical Goal status: ${String(input.status)}`);
  }
  stringOrNull(input.sourceGoalId, "sourceGoalId");
  assertNonEmpty(input.locator.sourcePath, "locator.sourcePath");
  const recordIndex = integerOrNull(input.locator.recordIndex, "locator.recordIndex");
  for (const field of INTEGER_FIELDS) integerOrNull(input[field], field);

  if (input.sourceMaterial === undefined && input.exactSourceSha256 === undefined) {
    throw new Error("Invalid canonical Goal source: expected source material or an exact source hash");
  }
  if (input.sourceMaterial !== undefined && input.exactSourceSha256 !== undefined) {
    throw new Error("Invalid canonical Goal source: provide source material or an exact source hash, not both");
  }
  const sourceSha256 = input.exactSourceSha256 ?? sha256Utf8(stableStringify(input.sourceMaterial));
  const snapshot: CanonicalGoalSnapshot = {
    version: 1,
    authority: input.authority,
    provider: input.provider,
    sourceThreadId: input.sourceThreadId,
    sourceGoalId: input.sourceGoalId,
    objective: input.objective,
    status: input.status,
    migrationEligible: input.status === "active",
    tokenBudget: input.tokenBudget,
    tokensUsed: input.tokensUsed,
    timeUsedSeconds: input.timeUsedSeconds,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.updatedAtMs,
    locator: { ...input.locator, recordIndex },
    sourceSha256,
  };
  validateCanonicalGoalSnapshot(snapshot);
  return snapshot;
}

export function validateCanonicalGoalSnapshot(value: unknown): asserts value is CanonicalGoalSnapshot {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid canonical Goal snapshot: expected an object");
  }
  const goal = value as Partial<CanonicalGoalSnapshot>;
  for (const field of SNAPSHOT_FIELDS) assertOwn(value, field);
  if (goal.version !== 1) throw new Error(`Invalid canonical Goal version: ${String(goal.version)}`);
  if (goal.authority !== "native-store" && goal.authority !== "native-transcript") {
    throw new Error(`Invalid canonical Goal authority: ${String(goal.authority)}`);
  }
  assertNonEmpty(goal.provider, "provider");
  assertNonEmpty(goal.sourceThreadId, "sourceThreadId");
  assertNonEmpty(goal.objective, "objective");
  stringOrNull(goal.sourceGoalId, "sourceGoalId");
  if (!GOAL_STATUSES.has(goal.status as GoalLifecycleStatus)) {
    throw new Error(`Invalid canonical Goal status: ${String(goal.status)}`);
  }
  if (goal.migrationEligible !== (goal.status === "active")) {
    throw new Error("Invalid canonical Goal migration eligibility");
  }
  for (const field of INTEGER_FIELDS) integerOrNull(goal[field], field);
  if (goal.locator == null || typeof goal.locator !== "object") {
    throw new Error("Invalid canonical Goal locator");
  }
  for (const field of ["sourcePath", "recordIndex", "table", "key"] as const) {
    assertOwn(goal.locator, field, "canonical Goal locator");
  }
  assertNonEmpty(goal.locator.sourcePath, "locator.sourcePath");
  integerOrNull(goal.locator.recordIndex, "locator.recordIndex");
  stringOrNull(goal.locator.table, "locator.table");
  stringOrNull(goal.locator.key, "locator.key");
  if (typeof goal.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(goal.sourceSha256)) {
    throw new Error("Invalid canonical Goal sourceSha256");
  }
}

interface CodexGoalRow {
  thread_id?: unknown;
  goal_id?: unknown;
  objective?: unknown;
  status?: unknown;
  token_budget?: unknown;
  tokens_used?: unknown;
  time_used_seconds?: unknown;
  created_at_ms?: unknown;
  updated_at_ms?: unknown;
}

function requiredString(value: unknown, field: string): string {
  assertNonEmpty(value, field);
  return value;
}

function codexStatus(value: unknown): GoalLifecycleStatus {
  if (typeof value === "string" && CODEX_GOAL_STATUSES.has(value as GoalLifecycleStatus)) {
    return value as GoalLifecycleStatus;
  }
  throw new Error(`Invalid Codex Goal status: ${String(value)}`);
}

export function assertGoalSourceBinding(
  goal: CanonicalGoalSnapshot,
  expected: { provider: string; authority: GoalAuthority; sourceThreadId: string },
): void {
  validateCanonicalGoalSnapshot(goal);
  if (goal.provider !== expected.provider) {
    throw new Error(`Canonical Goal provider mismatch: expected ${expected.provider}, got ${goal.provider}`);
  }
  if (goal.authority !== expected.authority) {
    throw new Error(`Canonical Goal authority mismatch: expected ${expected.authority}, got ${goal.authority}`);
  }
  if (goal.sourceThreadId !== expected.sourceThreadId) {
    throw new Error(
      `Canonical Goal thread id mismatch: expected ${expected.sourceThreadId}, got ${goal.sourceThreadId}`,
    );
  }
}

/** Read Codex's authoritative Goal row without opening its store for writes. */
export function readCodexGoalSnapshot(codexHome: string, threadId: string): CanonicalGoalSnapshot | null {
  assertNonEmpty(codexHome, "codexHome");
  assertNonEmpty(threadId, "sourceThreadId");
  const dbPath = path.join(codexHome, "goals_1.sqlite");
  if (!fs.existsSync(dbPath)) return null;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(`Cannot read Codex Goal store ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const table = db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'thread_goals' LIMIT 1",
    ).get();
    if (table == null) return null;
    let row: CodexGoalRow | undefined;
    try {
      row = db.prepare(`SELECT thread_id, goal_id, objective, status, token_budget,
        tokens_used, time_used_seconds, created_at_ms, updated_at_ms
        FROM thread_goals WHERE thread_id = ? LIMIT 1`).get(threadId) as CodexGoalRow | undefined;
    } catch (error) {
      throw new Error(`Invalid Codex Goal store schema: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (row == null) return null;
    const normalizedRow = {
      thread_id: requiredString(row.thread_id, "thread_id"),
      goal_id: requiredString(row.goal_id, "goal_id"),
      objective: requiredString(row.objective, "objective"),
      status: codexStatus(row.status),
      token_budget: integerOrNull(row.token_budget, "token_budget"),
      tokens_used: integerOrNull(row.tokens_used, "tokens_used"),
      time_used_seconds: integerOrNull(row.time_used_seconds, "time_used_seconds"),
      created_at_ms: integerOrNull(row.created_at_ms, "created_at_ms"),
      updated_at_ms: integerOrNull(row.updated_at_ms, "updated_at_ms"),
    };
    if (normalizedRow.thread_id !== threadId) {
      throw new Error(`Codex Goal thread id mismatch: expected ${threadId}`);
    }
    return createCanonicalGoalSnapshot({
      authority: "native-store",
      provider: "codex",
      sourceThreadId: normalizedRow.thread_id,
      sourceGoalId: normalizedRow.goal_id,
      objective: normalizedRow.objective,
      status: normalizedRow.status,
      tokenBudget: normalizedRow.token_budget,
      tokensUsed: normalizedRow.tokens_used,
      timeUsedSeconds: normalizedRow.time_used_seconds,
      createdAtMs: normalizedRow.created_at_ms,
      updatedAtMs: normalizedRow.updated_at_ms,
      locator: { sourcePath: dbPath, recordIndex: null, table: "thread_goals", key: threadId },
      sourceMaterial: normalizedRow,
    });
  } catch (error) {
    if (error instanceof Error && /^(Invalid|Codex Goal)/.test(error.message)) throw error;
    throw new Error(`Cannot read Codex Goal store ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}
