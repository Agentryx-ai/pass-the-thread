import { createHash } from "node:crypto";

import { summarizeLosses, type LossObservation, type LossReport } from "./loss-report.ts";
import { canonicalProjectIdentity } from "./project-identity.ts";
import { planGoalMigration, type GoalMigrationDecision } from "./goal.ts";
import {
  selectSessions,
  archiveState,
  projectMembership,
  type SelectionOptions,
  type SelectionSession,
} from "./selection.ts";

export interface ImportPlanSessionSummary extends SelectionSession {
  sourcePath?: string;
  sourceSha256?: string;
  title?: string;
  messageCount?: number;
  losses?: readonly LossObservation[];
  goalDecision?: GoalMigrationDecision;
}

export interface ImportPlanSession {
  sessionId: string;
  projectPath: string | null;
  projectKey: string | null;
  sourceProjectRootExists: boolean;
  projectName: string | null;
  projectMembership: "project" | "projectless" | "unknown";
  projectMembershipProvenance: string;
  archiveState: "active" | "archived" | "unknown";
  archiveProvenance: string;
  targetProjectExists: boolean | null;
  targetConversationExists: boolean | null;
  targetConversationState: "absent" | "exact-existing" | "collision" | "relocated" | "unknown";
  /** Present only when a transcript turned up outside the derived project directory. */
  relocatedTranscriptPaths?: string[];
  activityAtMs: number | null;
  sourcePath: string | null;
  sourceSha256: string | null;
  title: string | null;
  messageCount: number | null;
  goalDecision: GoalMigrationDecision;
}

export interface ImportPlan {
  version: 3;
  selection: {
    archive: "active" | "all" | "archived";
    projectScope: "all" | "projects" | "projectless" | "existing-targets";
    sessionIds: string[];
    projects: string[];
    fromMs: number | null;
    toMs: number | null;
    limit: number | null;
  };
  sessions: ImportPlanSession[];
  losses: LossReport;
}

export interface BuildImportPlanOptions {
  selection?: SelectionOptions;
}

export interface BuiltImportPlan {
  plan: ImportPlan;
  canonicalJson: string;
  /** Lowercase SHA-256 of the exact UTF-8 bytes in `canonicalJson`. */
  digest: string;
}

export const REGENERATE_PLAN_MESSAGE = "regenerate plan with current threadpass";

export function assertCurrentImportPlan(value: unknown): asserts value is ImportPlan {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`unsupported nested import plan; ${REGENERATE_PLAN_MESSAGE}`);
  }
  const plan = value as Record<string, unknown>;
  if (plan.version !== 3) {
    throw new Error(`unsupported nested import plan version ${String(plan.version)}; ${REGENERATE_PLAN_MESSAGE}`);
  }
  if (plan.selection == null || typeof plan.selection !== "object" || Array.isArray(plan.selection) ||
    !Array.isArray(plan.sessions) || plan.losses == null || typeof plan.losses !== "object" || Array.isArray(plan.losses)) {
    throw new Error(`malformed nested import plan; ${REGENERATE_PLAN_MESSAGE}`);
  }
}

/**
 * Build a deterministic, side-effect-free import plan from parsed summaries.
 * Session input order and object insertion order do not affect the output.
 */
export function buildImportPlan(
  sessions: readonly ImportPlanSessionSummary[],
  options: BuildImportPlanOptions = {},
): BuiltImportPlan {
  const selection = options.selection ?? {};
  const selected = preselectSessions(sessions, options);
  const rows = selected.map(toPlanSession).sort((left, right) => compareText(
    left.sessionId,
    right.sessionId,
  ));

  const plan: ImportPlan = {
    version: 3,
    selection: normalizeSelection(selection),
    sessions: rows,
    losses: summarizeLosses(selected.map((session) => ({
      ...session,
      losses: [...(session.losses ?? []), ...goalDecisionLosses(session.goalDecision ?? planGoalMigration(null))],
    }))),
  };
  const { canonicalJson, digest } = digestImportPlan(plan);
  return { plan, canonicalJson, digest };
}

/**
 * The selection `buildImportPlan` would apply, decided before anything is loaded.
 *
 * Selection reads nothing but the `SelectionSession` fields, so a source reader
 * can settle it from inventory metadata and then load bodies for the survivors
 * alone. Building the plan from those survivors is byte-identical to building it
 * from the whole inventory: this same ordering and filter run again over an
 * already-selected list keeps every one of them, and the plan is derived from
 * the selected sessions only. The unique-id guard still sees the whole
 * inventory, which is why it lives here rather than after the filter.
 */
export function preselectSessions<T extends ImportPlanSessionSummary>(
  sessions: readonly T[],
  options: BuildImportPlanOptions = {},
): T[] {
  ensureUniqueSessionIds(sessions);
  // Source readers commonly return newest-first, but a plan digest must not
  // depend on that caller detail. Stabilize before applying an explicit limit.
  const ordered = [...sessions].sort(compareSourceSessions);
  return selectSessions(ordered, options.selection ?? {});
}

export function digestImportPlan(plan: ImportPlan): Pick<BuiltImportPlan, "canonicalJson" | "digest"> {
  assertCurrentImportPlan(plan);
  const canonicalJson = canonicalStringify(plan);
  const digest = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return { canonicalJson, digest };
}

/** JSON with recursively sorted object keys and no insignificant whitespace. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonicalize(child);
    }
    return out;
  }
  throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
}

function toPlanSession(session: ImportPlanSessionSummary): ImportPlanSession {
  const root = session.projectRoot ?? session.cwd ?? "";
  const identity = root === "" ? null : canonicalProjectIdentity(root);
  return {
    sessionId: session.sessionId,
    projectPath: identity?.path ?? null,
    projectKey: identity?.key ?? null,
    sourceProjectRootExists: identity?.exists ?? false,
    projectName: session.projectName ?? null,
    projectMembership: projectMembership(session),
    projectMembershipProvenance: session.projectMembershipProvenance ??
      (session.projectMembership != null || session.hasProject != null ? "source-observation" : "unresolved"),
    archiveState: archiveState(session),
    archiveProvenance: session.archiveProvenance ??
      (session.archiveState != null || session.isArchived != null ? "source-observation" : "unresolved"),
    targetProjectExists: session.targetProjectExists ?? null,
    targetConversationExists: session.targetConversationExists ?? null,
    targetConversationState: session.targetConversationState ??
      (session.targetConversationExists === true ? "collision" :
        session.targetConversationExists === false ? "absent" : "unknown"),
    // The key itself is absent unless a transcript turned up out of place, so an
    // unaffected plan reads and digests exactly as it did before.
    ...(session.relocatedTranscriptPaths != null && session.relocatedTranscriptPaths.length > 0
      ? { relocatedTranscriptPaths: [...session.relocatedTranscriptPaths] }
      : {}),
    activityAtMs: session.lastTsMs ?? session.firstTsMs ?? null,
    sourcePath: session.sourcePath ?? null,
    sourceSha256: session.sourceSha256 ?? null,
    title: session.title ?? null,
    messageCount: session.messageCount ?? null,
    goalDecision: session.goalDecision ?? planGoalMigration(null),
  };
}

function goalDecisionLosses(decision: GoalMigrationDecision): LossObservation[] {
  if (decision.status === "pending_target_implementation") {
    return [{
      kind: "goal_activation_target_unimplemented",
      count: 1,
      detail: "An eligible authoritative source Goal is bound to the plan but cannot be activated by this version.",
    }];
  }
  if (decision.status === "skipped_by_policy" && decision.sourceGoalSha256 != null) {
    return [{
      kind: "goal_migration_skipped_by_policy",
      count: 1,
      detail: "The authoritative source Goal remains historical because Goal migration was skipped.",
    }];
  }
  if (decision.status === "historical_only") {
    return [{
      kind: "goal_ineligible_historical_only",
      count: 1,
      detail: "The terminal or otherwise ineligible authoritative source Goal remains historical.",
    }];
  }
  return [];
}

function normalizeSelection(selection: SelectionOptions): ImportPlan["selection"] {
  return {
    archive: selection.archive ?? "active",
    projectScope: selection.projectScope ?? "all",
    sessionIds: [...new Set(selection.sessionIds ?? [])].sort(),
    projects: [...new Set((selection.projects ?? []).map(normalizeProjectSelector))].sort(),
    fromMs: selection.fromMs ?? null,
    toMs: selection.toMs ?? null,
    limit: selection.limit ?? null,
  };
}

function normalizeProjectSelector(selector: string): string {
  const isPath = /^[A-Za-z]:[\\/]/.test(selector) || /^[\\/]{2}/.test(selector) ||
    selector.includes("/") || selector.includes("\\");
  return isPath ? canonicalProjectIdentity(selector).key : selector.toLowerCase();
}

function ensureUniqueSessionIds(sessions: readonly ImportPlanSessionSummary[]): void {
  const seen = new Set<string>();
  for (const session of sessions) {
    if (session.sessionId === "") throw new TypeError("sessionId must not be empty");
    if (seen.has(session.sessionId)) {
      throw new Error(`duplicate sessionId in import plan: ${session.sessionId}`);
    }
    seen.add(session.sessionId);
  }
}

function compareSourceSessions(
  left: ImportPlanSessionSummary,
  right: ImportPlanSessionSummary,
): number {
  const leftActivity = left.lastTsMs ?? left.firstTsMs ?? Number.NEGATIVE_INFINITY;
  const rightActivity = right.lastTsMs ?? right.firstTsMs ?? Number.NEGATIVE_INFINITY;
  return rightActivity - leftActivity || compareText(left.sessionId, right.sessionId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

