import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalProjectIdentity,
  sameProject,
  stripWindowsExtendedPrefix,
} from "../src/project-identity.ts";
import { assertSelectorsResolve, selectSessions, type SelectionSession } from "../src/selection.ts";
import { summarizeLosses } from "../src/loss-report.ts";
import { buildImportPlan, digestImportPlan, preselectSessions } from "../src/import-plan.ts";
import { loadDesktopSelectionResult, projectForCwd } from "../src/codex-desktop-state.ts";

function session(
  sessionId: string,
  overrides: Partial<SelectionSession> = {},
): SelectionSession {
  return {
    sessionId,
    cwd: String.raw`C:\work\${sessionId}`,
    hasProject: true,
    isArchived: false,
    lastTsMs: 100,
    ...overrides,
  };
}

test("extended drive and UNC prefixes are stripped without changing their target", () => {
  assert.equal(stripWindowsExtendedPrefix("\\\\?\\C:\\work"), "C:\\work");
  assert.equal(
    stripWindowsExtendedPrefix("\\\\?\\UNC\\server\\share\\work"),
    "\\\\server\\share\\work",
  );
});

test("canonical project identity normalizes Windows spellings and compares without case", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-identity-"));
  const nativeIdentity = canonicalProjectIdentity(dir + path.sep);
  assert.equal(nativeIdentity.exists, true);
  assert.equal(nativeIdentity.path.endsWith(path.sep), false);

  const windowsPath = process.platform === "win32"
    ? path.join(dir, "missing", "Project")
    : String.raw`C:\work\Project`;
  const extended = "\\\\?\\" + windowsPath.replaceAll("/", "\\") + "\\";
  const ordinary = windowsPath.toUpperCase().replaceAll("\\", "/");
  const identity = canonicalProjectIdentity(extended);
  assert.equal(identity.exists, false);
  assert.equal(identity.path, path.win32.normalize(windowsPath));
  assert.equal(identity.path.endsWith("\\"), false);
  assert.equal(identity.key, identity.path.toLowerCase());
  assert.equal(sameProject(identity, ordinary), true);
});

test("forward- and backslash UNC spellings share a canonical identity", () => {
  const forward = "//localhost/__pass_the_thread_missing_share__/Project/";
  const backward = String.raw`\\localhost\__pass_the_thread_missing_share__\project`;

  assert.equal(canonicalProjectIdentity(forward).exists, false);
  assert.equal(sameProject(forward, backward), true);
});

test("an existing POSIX double-slash path retains host-native identity", {
  skip: process.platform === "win32",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-identity-double-slash-"));
  const doubleSlash = `/${dir}`;

  const identity = canonicalProjectIdentity(doubleSlash);
  assert.equal(identity.exists, true);
  assert.equal(identity.path, fs.realpathSync.native(dir));
  assert.equal(sameProject(identity, dir), true);
});

test("canonical project identity resolves and normalizes a path even when absent", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "project-identity-"));
  const input = path.join(base, "missing", "..", "future") + path.sep;
  const identity = canonicalProjectIdentity(input);

  assert.equal(identity.exists, false);
  assert.equal(identity.path, path.resolve(base, "future"));
  assert.equal(identity.key, identity.path.toLowerCase());
});

test("selection defaults to every active session and has no implicit cap", () => {
  const active = Array.from({ length: 75 }, (_, i) => session(`s${i}`));
  const archived = session("old", { isArchived: true });

  assert.equal(selectSessions([...active, archived]).length, 75);
  assert.deepEqual(
    selectSessions([...active, archived], { archive: "archived" }).map((s) => s.sessionId),
    ["old"],
  );
  assert.equal(selectSessions([...active, archived], { archive: "all" }).length, 76);
});

test("unknown archive state remains visible unfiltered and requested archive filters fail", () => {
  const unknown = session("unknown-archive", {
    isArchived: undefined,
    archiveState: "unknown",
    archiveProvenance: "missing-native-archive-field",
  });
  assert.deepEqual(selectSessions([unknown], { archive: "all" }), [unknown]);
  assert.throws(() => selectSessions([unknown], { archive: "active" }), /archive state is unknown/);
  assert.throws(() => selectSessions([unknown], { archive: "archived" }), /archive state is unknown/);
  assert.deepEqual(selectSessions([unknown], { archive: "active", sessionIds: ["other"] }), []);

  const built = buildImportPlan([unknown], { selection: { archive: "all" } });
  assert.equal(built.plan.sessions[0]?.archiveState, "unknown");
  assert.equal(built.plan.sessions[0]?.archiveProvenance, "missing-native-archive-field");
});

test("selection separates project membership, target project existence, and conversation collisions", () => {
  const sessions = [
    session("project", { projectName: "Alpha", targetProjectExists: false, targetConversationExists: false }),
    session("existing", { projectName: "Beta", targetProjectExists: true, targetConversationExists: false }),
    session("collision", { projectName: "Beta", targetProjectExists: true, targetConversationExists: true }),
    session("recent", { hasProject: false, projectName: undefined, targetProjectExists: false }),
  ];
  const ids = (projectScope: "projects" | "projectless" | "existing-targets") =>
    selectSessions(sessions, { projectScope }).map((s) => s.sessionId);

  assert.deepEqual(ids("projects"), ["project", "existing", "collision"]);
  assert.deepEqual(ids("projectless"), ["recent"]);
  assert.deepEqual(ids("existing-targets"), ["existing", "collision"]);
});

test("Desktop project matching canonicalizes realpath aliases without mutating global state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-project-alias-"));
  const real = path.join(root, "real-project");
  const alias = path.join(root, "alias-project");
  fs.mkdirSync(path.join(real, "nested"), { recursive: true });
  try {
    fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return;
  }
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome);
  const globalState = path.join(codexHome, ".codex-global-state.json");
  fs.writeFileSync(globalState, JSON.stringify({
    "local-projects": { p: { name: "Alias", rootPaths: [alias] } },
    "project-order": ["p"],
  }));
  const before = fs.readFileSync(globalState);
  const loaded = loadDesktopSelectionResult(codexHome);
  assert.equal(loaded.status, "available");
  assert.equal(projectForCwd(loaded.selection!, path.join(real, "nested"))?.name, "Alias");
  assert.deepEqual(fs.readFileSync(globalState), before);
});

test("an assignment to an unregistered Desktop project remains unknown, not projectless", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-project-unknown-"));
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": {},
    "thread-project-assignments": {
      thread: { projectId: "missing-project" },
      projectless: { projectId: "missing-project" },
    },
    "projectless-thread-ids": ["projectless"],
  }));
  const loaded = loadDesktopSelectionResult(codexHome);
  assert.equal(loaded.status, "available");
  assert.equal(loaded.selection?.unknownThreadIds.has("thread"), true);
  assert.equal(loaded.selection?.threadProject.has("thread"), false);
  assert.equal(loaded.selection?.unknownThreadIds.has("projectless"), true);
  assert.equal(loaded.selection?.threadProject.has("projectless"), false);
});

test("an empty assignment map is authoritative assigned mode", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-project-empty-assigned-"));
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { project: { name: "Project", rootPaths: [codexHome] } },
    "thread-project-assignments": {},
    "projectless-thread-ids": [],
  }));
  const loaded = loadDesktopSelectionResult(codexHome);
  assert.equal(loaded.status, "available");
  assert.equal(loaded.selection?.mode, "assigned");
  assert.equal(loaded.selection?.threadProject.size, 0);
});

test("malformed Desktop membership substructures make valid JSON unusable", () => {
  const malformed = [
    { "local-projects": [] },
    { "local-projects": { p: { rootPaths: [1] } } },
    { "projectless-thread-ids": [1] },
    { "thread-project-assignments": [] },
    { "thread-project-assignments": { thread: {} } },
  ];
  for (const state of malformed) {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-project-malformed-"));
    fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify(state));
    const loaded = loadDesktopSelectionResult(codexHome);
    assert.equal(loaded.status, "unusable");
    assert.equal(loaded.selection, null);
  }
});

test("filters fail visibly when project membership, target registration, or activity is unknown", () => {
  const unknownMembership = session("membership", { hasProject: undefined, projectMembership: "unknown" });
  const unknownTarget = session("target", { targetProjectExists: null });
  const unknownActivity = session("activity", { firstTsMs: null, lastTsMs: null });

  assert.throws(() => selectSessions([unknownMembership], { projectScope: "projectless" }), /membership is unknown/);
  assert.throws(() => selectSessions([unknownTarget], { projectScope: "existing-targets" }), /existence is unknown/);
  assert.throws(() => selectSessions([unknownActivity], { fromMs: 0 }), /timestamp is unknown/);
  assert.equal(selectSessions([unknownMembership]).length, 1, "unfiltered scans keep unknown membership visible");
});

test("repeated session/project selectors, inclusive time bounds, and explicit limit compose", () => {
  const sessions = [
    session("a", { projectName: "Alpha", lastTsMs: 10 }),
    session("b", { projectName: "Beta", lastTsMs: 20 }),
    session("c", { projectName: "Beta", lastTsMs: 30 }),
  ];

  const selected = selectSessions(sessions, {
    sessionIds: ["a", "b", "c"],
    projects: ["Alpha", "Beta"],
    fromMs: 20,
    toMs: 30,
    limit: 1,
  });
  assert.deepEqual(selected.map((s) => s.sessionId), ["b"]);
  assert.deepEqual(selectSessions(sessions, { fromMs: 30, toMs: 30 }).map((s) => s.sessionId), ["c"]);
  assert.deepEqual(selectSessions(sessions, { limit: 0 }), []);
  assert.throws(() => selectSessions(sessions, { limit: -1 }), /limit/);
  assert.throws(() => selectSessions(sessions, { fromMs: 30, toMs: 20 }), /fromMs/);
});

test("an explicit selector that matches nothing in the inventory is reported, not silently dropped", () => {
  const sessions = [
    session("a", { projectName: "Alpha" }),
    session("b", { projectName: "Beta" }),
  ];

  // One good id and one that matches nothing: the bad one is named.
  assert.throws(
    () => assertSelectorsResolve(sessions, { sessionIds: ["a", "no-such-id"] }),
    /--session matched no session in the inventory: no-such-id/,
  );
  // A typo'd project name is reported the same way.
  assert.throws(
    () => assertSelectorsResolve(sessions, { projects: ["Alpha", "Gemma"] }),
    /--project matched no project in the inventory: Gemma/,
  );
  // A CRLF-fed id list is the observed real-world shape: trim before matching,
  // rather than reporting a trimmed id as unmatched.
  assert.doesNotThrow(() => assertSelectorsResolve(sessions, { sessionIds: ["a\r\n", " b "] }));
  // Every selector matching is silent, as before.
  assert.doesNotThrow(() => assertSelectorsResolve(sessions, { sessionIds: ["a", "b"], projects: ["Alpha", "Beta"] }));
});

test("running the unmatched-selector check ahead of a plan build changes nothing when every selector matches", () => {
  const inventory = [
    session("a", { projectName: "Alpha", lastTsMs: 10 }),
    session("b", { projectName: "Beta", lastTsMs: 20 }),
  ];
  const selection = { archive: "all" as const, sessionIds: ["a"], projects: ["Alpha"] };

  const withoutCheck = buildImportPlan(inventory, { selection });
  // What every selection CLI chokepoint now does before building the plan.
  assert.doesNotThrow(() => assertSelectorsResolve(inventory, selection));
  const withCheck = buildImportPlan(inventory, { selection });

  assert.equal(withCheck.digest, withoutCheck.digest);
  assert.equal(withCheck.canonicalJson, withoutCheck.canonicalJson);
});

test("loss summaries aggregate explicit adapter observations deterministically", () => {
  const report = summarizeLosses([
    {
      sessionId: "b",
      losses: [
        { kind: "source-compaction", count: 4, detail: "source history was compacted" },
        { kind: "tool-output-truncated", count: 2, detail: "size cap" },
      ],
    },
    {
      sessionId: "a",
      losses: [{ kind: "tool-output-truncated", count: 1, detail: "size cap" }],
    },
  ]);

  assert.equal(report.totalCount, 7);
  assert.equal(report.lossySessionCount, 2);
  assert.deepEqual(report.byKind.map((entry) => [entry.kind, entry.count]), [
    ["source-compaction", 4],
    ["tool-output-truncated", 3],
  ]);
  assert.deepEqual(report.byKind[1].sessionIds, ["a", "b"]);
});

test("import plans and their digest are canonical across input order and path spelling", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "import-plan-"));
  const first = {
    sessionId: "b",
    cwd: "\\\\?\\" + base.replaceAll("/", "\\") + "\\",
    sourceSha256: "bb",
    sourcePath: "b.jsonl",
    lastTsMs: 20,
    messageCount: 2,
    isArchived: false,
  };
  const second = {
    sessionId: "a",
    cwd: base.toUpperCase(),
    sourceSha256: "aa",
    sourcePath: "a.jsonl",
    lastTsMs: 10,
    messageCount: 1,
    isArchived: false,
  };

  const one = buildImportPlan([first, second]);
  const two = buildImportPlan([second, first]);

  assert.equal(one.canonicalJson, two.canonicalJson);
  assert.equal(one.digest, two.digest);
  assert.deepEqual(one.plan.sessions.map((s) => s.sessionId), ["a", "b"]);
  assert.equal(
    one.digest,
    createHash("sha256").update(one.canonicalJson, "utf8").digest("hex"),
  );
  assert.deepEqual(JSON.parse(one.canonicalJson), one.plan);
  assert.equal(one.plan.sessions[0]?.projectMembership, "unknown");
  assert.equal(one.plan.sessions[0]?.projectMembershipProvenance, "unresolved");
});

test("an import plan applies a limit deterministically to newest sessions", () => {
  const old = session("old", { lastTsMs: 10 });
  const newest = session("newest", { lastTsMs: 30 });
  const middle = session("middle", { lastTsMs: 20 });

  const one = buildImportPlan([old, newest, middle], { selection: { limit: 2 } });
  const two = buildImportPlan([middle, old, newest], { selection: { limit: 2 } });

  assert.equal(one.digest, two.digest);
  assert.deepEqual(one.plan.sessions.map((entry) => entry.sessionId), ["middle", "newest"]);
});

test("changing a stored plan session changes its confirmation digest", () => {
  const built = buildImportPlan([session("one", { isArchived: false })], {
    selection: { archive: "all" },
  });
  const changed = structuredClone(built.plan);
  changed.sessions[0].archiveState = "archived";
  assert.notEqual(digestImportPlan(changed).digest, built.digest);
});


test("pruning the inventory before load leaves the plan and its digest unchanged", () => {
  const inventory = [
    session("newest", { lastTsMs: 300, projectName: "alpha" }),
    session("middle", { lastTsMs: 200, projectName: "alpha" }),
    session("oldest", { lastTsMs: 100, projectName: "beta", isArchived: true }),
  ];
  for (const selection of [
    { archive: "all" as const },
    { archive: "all" as const, limit: 2 },
    { archive: "all" as const, sessionIds: ["middle"] },
    { archive: "active" as const, projects: ["alpha"] },
    { archive: "all" as const, fromMs: 150, toMs: 250 },
  ]) {
    // What a source reader that decides selection from metadata hands the plan
    // builder, against what it used to hand it: the whole inventory.
    const pruned = buildImportPlan(preselectSessions(inventory, { selection }), { selection });
    const whole = buildImportPlan(inventory, { selection });
    assert.equal(pruned.canonicalJson, whole.canonicalJson);
    assert.equal(pruned.digest, whole.digest);
  }
});

test("selection that fails closed on an unknown still fails when it is decided early", () => {
  const inventory = [session("known"), session("unknown", { isArchived: undefined })];
  assert.throws(() => preselectSessions(inventory, { selection: { archive: "active" } }),
    /archive state is unknown for unknown/);
  const undated = [session("known"), session("undated", { lastTsMs: null, firstTsMs: null })];
  assert.throws(() => preselectSessions(undated, { selection: { fromMs: 150, toMs: 250 } }),
    /source activity timestamp is unknown for undated/);
  assert.throws(() => buildImportPlan(undated, { selection: { fromMs: 150, toMs: 250 } }),
    /source activity timestamp is unknown for undated/);
  // A selector that excludes the unknown session never judges it, before or after.
  assert.deepEqual(
    preselectSessions(inventory, { selection: { archive: "active", sessionIds: ["known"] } })
      .map((entry) => entry.sessionId),
    ["known"],
  );
});
