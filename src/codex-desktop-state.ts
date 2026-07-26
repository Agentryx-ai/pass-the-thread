// Read Codex Desktop's UI state (.codex-global-state.json) to group threads the
// way the Desktop's left sidebar does.
//
// Two shapes exist in the wild:
//  - "assigned": the state file carries an explicit `thread-project-assignments`
//    map. Together with `projectless-thread-ids` that map *is* the sidebar
//    membership, so selection can be driven straight off it.
//  - "derived" (current Codex Desktop): there is no assignment map. Projects are
//    registered under `local-projects` with `rootPaths`, and a thread belongs to
//    whichever project contains its cwd; `projectless-thread-ids` only covers
//    Desktop-created threads that have no workspace. Membership therefore has to
//    come from the thread index, with this file supplying the grouping.
//
// Treating the second shape like the first selects almost nothing, because the
// assignment map is simply absent.
import fs from "node:fs";
import path from "node:path";
import { canonicalProjectIdentity } from "./project-identity.ts";

export interface DesktopProject {
  projectId: string;
  name: string;
  rootPaths: string[];
}
export interface DesktopSelection {
  /**
   * "assigned": `threadProject` is the sidebar membership.
   * "derived":  membership comes from the thread index; use `projectForCwd`.
   */
  mode: "assigned" | "derived";
  /** threadId -> owning project (or null for projectless). Empty when derived. */
  threadProject: Map<string, DesktopProject | null>;
  /** Threads Codex Desktop tracks as having no project. */
  projectlessThreadIds: Set<string>;
  /** Assigned records whose project id is missing or not registered. */
  unknownThreadIds: Set<string>;
  projects: Map<string, DesktopProject>;
  projectOrder: string[];
}

export interface DesktopSelectionResult {
  status: "available" | "missing" | "unreadable" | "unusable";
  sourcePath: string;
  selection: DesktopSelection | null;
  detail: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function findGlobalState(codexHome: string): string | null {
  const p = path.join(codexHome, ".codex-global-state.json");
  return fs.existsSync(p) ? p : null;
}

export function loadDesktopSelection(codexHome: string): DesktopSelection | null {
  return loadDesktopSelectionResult(codexHome).selection;
}

export function loadDesktopSelectionResult(codexHome: string): DesktopSelectionResult {
  const sourcePath = path.join(codexHome, ".codex-global-state.json");
  const p = findGlobalState(codexHome);
  if (!p) return { status: "missing", sourcePath, selection: null, detail: "global state file does not exist" };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    if (!isRecord(j)) {
      return { status: "unusable", sourcePath: p, selection: null, detail: "global state root is not an object" };
    }
  } catch (error) {
    return {
      status: "unreadable", sourcePath: p, selection: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const unusable = (detail: string): DesktopSelectionResult => ({
    status: "unusable", sourcePath: p, selection: null, detail,
  });
  const rawProjectsValue = j["local-projects"];
  if (rawProjectsValue !== undefined && !isRecord(rawProjectsValue)) {
    return unusable("local-projects is not an object");
  }
  const rawProjects = rawProjectsValue ?? {};
  const projects = new Map<string, DesktopProject>();
  for (const [pid, v] of Object.entries(rawProjects)) {
    if (pid === "" || !isRecord(v)) return unusable("local-projects contains a malformed project");
    if (v.name !== undefined && typeof v.name !== "string") {
      return unusable(`local-projects.${pid}.name is not a string`);
    }
    if (v.rootPaths !== undefined && (!Array.isArray(v.rootPaths) ||
      v.rootPaths.some((root) => typeof root !== "string" || root === ""))) {
      return unusable(`local-projects.${pid}.rootPaths is not an array of nonempty strings`);
    }
    projects.set(pid, {
      projectId: pid,
      name: typeof v.name === "string" ? v.name : pid,
      rootPaths: Array.isArray(v.rootPaths) ? [...v.rootPaths] as string[] : [],
    });
  }

  const rawProjectless = j["projectless-thread-ids"];
  if (rawProjectless !== undefined && (!Array.isArray(rawProjectless) ||
    rawProjectless.some((tid) => typeof tid !== "string" || tid === ""))) {
    return unusable("projectless-thread-ids is not an array of nonempty strings");
  }
  const projectlessThreadIds = new Set<string>();
  for (const tid of rawProjectless ?? []) projectlessThreadIds.add(tid as string);

  const rawAssignments = j["thread-project-assignments"];
  const hasAssignments = Object.prototype.hasOwnProperty.call(j, "thread-project-assignments");
  if (hasAssignments && !isRecord(rawAssignments)) {
    return unusable("thread-project-assignments is not an object");
  }
  const assignments = hasAssignments ? rawAssignments as Record<string, unknown> : {};
  if (hasAssignments) {
    for (const [tid, assignment] of Object.entries(assignments)) {
      if (tid === "" || !isRecord(assignment) ||
        typeof assignment.projectId !== "string" || assignment.projectId === "") {
        return unusable("thread-project-assignments contains a malformed assignment");
      }
    }
  }

  const rawProjectOrder = j["project-order"];
  if (rawProjectOrder !== undefined && (!Array.isArray(rawProjectOrder) ||
    rawProjectOrder.some((pid) => typeof pid !== "string" || pid === ""))) {
    return unusable("project-order is not an array of nonempty strings");
  }
  const projectOrder = rawProjectOrder == null ? [] : [...rawProjectOrder] as string[];

  const threadProject = new Map<string, DesktopProject | null>();
  const unknownThreadIds = new Set<string>();
  if (hasAssignments) {
    for (const [tid, v] of Object.entries(assignments)) {
      const project = projects.get((v as { projectId: string }).projectId);
      if (project == null) unknownThreadIds.add(tid);
      else threadProject.set(tid, project);
    }
    for (const tid of projectlessThreadIds) {
      if (Object.prototype.hasOwnProperty.call(assignments, tid)) {
        threadProject.delete(tid);
        unknownThreadIds.add(tid);
      } else {
        threadProject.set(tid, null);
      }
    }
    const selection = {
      mode: "assigned",
      threadProject,
      projectlessThreadIds,
      unknownThreadIds,
      projects,
      projectOrder,
    } satisfies DesktopSelection;
    return { status: "available", sourcePath: p, selection, detail: null };
  }

  // No assignment map: this only helps if it can still say what the projects are.
  if (projects.size === 0 && projectlessThreadIds.size === 0) {
    return {
      status: "unusable", sourcePath: p, selection: null,
      detail: "global state has no project registration or projectless membership",
    };
  }
  const selection = {
    mode: "derived", threadProject, projectlessThreadIds, unknownThreadIds, projects, projectOrder,
  } satisfies DesktopSelection;
  return { status: "available", sourcePath: p, selection, detail: null };
}

/**
 * The project owning a thread's cwd, by longest matching root path. Codex
 * Desktop groups a thread under a project when the thread works inside one of
 * that project's roots; nested roots make the longest match the right one.
 */
export function projectForCwd(
  selection: DesktopSelection,
  cwd: string,
): DesktopProject | null {
  if (cwd === "") return null;
  const needle = canonicalProjectIdentity(cwd).key;
  let best: { project: DesktopProject; len: number } | null = null;
  for (const project of selection.projects.values()) {
    for (const raw of project.rootPaths) {
      let root: string;
      try { root = canonicalProjectIdentity(raw).key; } catch { continue; }
      if (needle !== root && !needle.startsWith(root + path.sep.toLowerCase())) continue;
      if (best == null || root.length > best.len) best = { project, len: root.length };
    }
  }
  return best?.project ?? null;
}
