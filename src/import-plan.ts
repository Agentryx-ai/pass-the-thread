import { createHash } from "node:crypto";

import { summarizeLosses, type LossObservation, type LossReport } from "./loss-report.ts";
import { canonicalProjectIdentity } from "./project-identity.ts";
import { planGoalMigration, type GoalMigrationDecision } from "./goal.ts";
import {
  selectSessions,
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
  projectExists: boolean;
  projectName: string | null;
  hasProject: boolean;
  archived: boolean;
  targetExists: boolean;
  activityAtMs: number | null;
  sourcePath: string | null;
  sourceSha256: string | null;
  title: string | null;
  messageCount: number | null;
  goalDecision: GoalMigrationDecision;
}

export interface ImportPlan {
  version: 2;
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

/**
 * Build a deterministic, side-effect-free import plan from parsed summaries.
 * Session input order and object insertion order do not affect the output.
 */
export function buildImportPlan(
  sessions: readonly ImportPlanSessionSummary[],
  options: BuildImportPlanOptions = {},
): BuiltImportPlan {
  ensureUniqueSessionIds(sessions);
  const selection = options.selection ?? {};
  // Source readers commonly return newest-first, but a plan digest must not
  // depend on that caller detail. Stabilize before applying an explicit limit.
  const ordered = [...sessions].sort(compareSourceSessions);
  const selected = selectSessions(ordered, selection);
  const rows = selected.map(toPlanSession).sort((left, right) => compareText(
    left.sessionId,
    right.sessionId,
  ));

  const plan: ImportPlan = {
    version: 2,
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

export function digestImportPlan(plan: ImportPlan): Pick<BuiltImportPlan, "canonicalJson" | "digest"> {
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
    projectExists: identity?.exists ?? false,
    projectName: session.projectName ?? null,
    hasProject: session.hasProject === true,
    archived: session.isArchived === true,
    targetExists: session.targetExists === true,
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

