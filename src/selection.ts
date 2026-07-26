import { canonicalProjectIdentity } from "./project-identity.ts";

export type ArchiveSelection = "active" | "all" | "archived";
export type ProjectScope = "all" | "projects" | "projectless" | "existing-targets";

/** Minimal structural contract accepted from any source reader. */
export interface SelectionSession {
  sessionId: string;
  cwd?: string;
  projectRoot?: string;
  projectName?: string;
  hasProject?: boolean;
  isArchived?: boolean;
  targetExists?: boolean;
  firstTsMs?: number | null;
  lastTsMs?: number | null;
}

export interface SelectionOptions {
  /** Active conversations are the safe/default source set. */
  archive?: ArchiveSelection;
  projectScope?: ProjectScope;
  /** Repeating a session selector forms an OR-list. */
  sessionIds?: readonly string[];
  /** Repeating a project selector forms an OR-list (exact name or canonical root). */
  projects?: readonly string[];
  /** Inclusive activity-time bounds. */
  fromMs?: number;
  toMs?: number;
  /** Applied last. There is no implicit limit; an explicit zero selects nothing. */
  limit?: number;
}

/**
 * Select source summaries without mutating or reordering them.
 *
 * Values repeated within `sessionIds` or `projects` are ORed. Different filter
 * families are ANDed, as are archive, project scope, and time constraints.
 */
export function selectSessions<T extends SelectionSession>(
  sessions: readonly T[],
  options: SelectionOptions = {},
): T[] {
  validateOptions(options);
  const archive = options.archive ?? "active";
  const projectScope = options.projectScope ?? "all";
  const sessionIds = options.sessionIds == null ? null : new Set(options.sessionIds);
  const projects = options.projects == null ? null : [...options.projects];

  const selected = sessions.filter((session) => {
    if (archive === "active" && session.isArchived === true) return false;
    if (archive === "archived" && session.isArchived !== true) return false;

    if (projectScope === "projects" && session.hasProject !== true) return false;
    if (projectScope === "projectless" && session.hasProject === true) return false;
    if (projectScope === "existing-targets" && session.targetExists !== true) return false;

    if (sessionIds != null && !sessionIds.has(session.sessionId)) return false;
    if (projects != null && !projects.some((selector) => matchesProject(session, selector))) {
      return false;
    }

    const activity = session.lastTsMs ?? session.firstTsMs ?? null;
    if (options.fromMs != null && (activity == null || activity < options.fromMs)) return false;
    if (options.toMs != null && (activity == null || activity > options.toMs)) return false;
    return true;
  });

  return options.limit == null ? selected : selected.slice(0, options.limit);
}

function matchesProject(session: SelectionSession, selector: string): boolean {
  if ((session.projectName ?? "").toLowerCase() === selector.toLowerCase()) {
    return true;
  }
  const root = session.projectRoot ?? session.cwd;
  if (root == null || root === "" || !looksLikePath(selector)) return false;
  return canonicalProjectIdentity(root).key === canonicalProjectIdentity(selector).key;
}

function looksLikePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value) || value.includes("/") || value.includes("\\");
}

function validateOptions(options: SelectionOptions): void {
  if (options.archive != null && !["active", "all", "archived"].includes(options.archive)) {
    throw new TypeError(`unsupported archive selection: ${String(options.archive)}`);
  }
  if (
    options.projectScope != null &&
    !["all", "projects", "projectless", "existing-targets"].includes(options.projectScope)
  ) {
    throw new TypeError(`unsupported project scope: ${String(options.projectScope)}`);
  }
  if (options.limit != null && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new RangeError("limit must be a non-negative safe integer");
  }
  for (const [name, value] of [["fromMs", options.fromMs], ["toMs", options.toMs]] as const) {
    if (value != null && !Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  }
  if (options.fromMs != null && options.toMs != null && options.fromMs > options.toMs) {
    throw new RangeError("fromMs must be less than or equal to toMs");
  }
  for (const id of options.sessionIds ?? []) {
    if (id === "") throw new TypeError("session selector must not be empty");
  }
  for (const project of options.projects ?? []) {
    if (project === "") throw new TypeError("project selector must not be empty");
  }
}


