import { canonicalProjectIdentity } from "./project-identity.ts";

export type ArchiveSelection = "active" | "all" | "archived";
export type ArchiveState = "active" | "archived" | "unknown";
export type ProjectScope = "all" | "projects" | "projectless" | "existing-targets";

/** Minimal structural contract accepted from any source reader. */
export interface SelectionSession {
  sessionId: string;
  cwd?: string;
  projectRoot?: string;
  projectName?: string;
  hasProject?: boolean;
  /** Explicit source grouping. Omitted legacy booleans are treated as unknown. */
  projectMembership?: "project" | "projectless" | "unknown";
  projectMembershipProvenance?: string;
  /** Legacy native boolean, retained for source adapters that already know it. */
  isArchived?: boolean;
  archiveState?: ArchiveState;
  archiveProvenance?: string;
  /** Canonical target project/group/root registration status. */
  targetProjectExists?: boolean | null;
  /** Exact planned target conversation artifact/registration status. */
  targetConversationExists?: boolean;
  /**
   * `relocated` means a transcript with this session id exists somewhere other
   * than the path the project root derives. It is neither absent nor a plain
   * collision, and never an invitation to create.
   */
  targetConversationState?: "absent" | "exact-existing" | "collision" | "relocated" | "unknown";
  /** Transcripts carrying this session id outside the derived project directory. */
  relocatedTranscriptPaths?: readonly string[];
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
    if (sessionIds != null && !sessionIds.has(session.sessionId)) return false;

    const observedArchive = archiveState(session);
    if (archive !== "all" && observedArchive === "unknown") {
      throw new Error(`archive state is unknown for ${session.sessionId}`);
    }
    if (archive === "active" && observedArchive !== "active") return false;
    if (archive === "archived" && observedArchive !== "archived") return false;

    const membership = projectMembership(session);
    if ((projectScope === "projects" || projectScope === "projectless" || projects != null) &&
      membership === "unknown") {
      throw new Error(`project membership is unknown for ${session.sessionId}`);
    }
    if (projectScope === "projects" && membership !== "project") return false;
    if (projectScope === "projectless" && membership !== "projectless") return false;
    if (projectScope === "existing-targets") {
      if (session.targetProjectExists == null) {
        throw new Error(`target project existence is unknown for ${session.sessionId}`);
      }
      if (!session.targetProjectExists) return false;
    }

    if (projects != null && !projects.some((selector) => matchesProject(session, selector))) {
      return false;
    }

    const activity = session.lastTsMs ?? session.firstTsMs ?? null;
    if ((options.fromMs != null || options.toMs != null) && activity == null) {
      throw new Error(`source activity timestamp is unknown for ${session.sessionId}`);
    }
    if (options.fromMs != null && activity! < options.fromMs) return false;
    if (options.toMs != null && activity! > options.toMs) return false;
    return true;
  });

  return options.limit == null ? selected : selected.slice(0, options.limit);
}

export function projectMembership(session: SelectionSession): "project" | "projectless" | "unknown" {
  if (session.projectMembership != null) return session.projectMembership;
  if (session.hasProject === true) return "project";
  if (session.hasProject === false) return "projectless";
  return "unknown";
}

export function archiveState(session: SelectionSession): ArchiveState {
  if (session.archiveState != null) return session.archiveState;
  if (session.isArchived === true) return "archived";
  if (session.isArchived === false) return "active";
  return "unknown";
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


