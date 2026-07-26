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
import { selectSessions, type SelectionSession } from "../src/selection.ts";
import { summarizeLosses } from "../src/loss-report.ts";
import { buildImportPlan, digestImportPlan } from "../src/import-plan.ts";

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

test("selection separates project, projectless, and existing-target scopes", () => {
  const sessions = [
    session("project", { projectName: "Alpha", targetExists: false }),
    session("existing", { projectName: "Beta", targetExists: true }),
    session("recent", { hasProject: false, projectName: undefined, targetExists: false }),
  ];
  const ids = (projectScope: "projects" | "projectless" | "existing-targets") =>
    selectSessions(sessions, { projectScope }).map((s) => s.sessionId);

  assert.deepEqual(ids("projects"), ["project", "existing"]);
  assert.deepEqual(ids("projectless"), ["recent"]);
  assert.deepEqual(ids("existing-targets"), ["existing"]);
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
  assert.deepEqual(selectSessions(sessions, { limit: 0 }), []);
  assert.throws(() => selectSessions(sessions, { limit: -1 }), /limit/);
  assert.throws(() => selectSessions(sessions, { fromMs: 30, toMs: 20 }), /fromMs/);
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
  };
  const second = {
    sessionId: "a",
    cwd: base.toUpperCase(),
    sourceSha256: "aa",
    sourcePath: "a.jsonl",
    lastTsMs: 10,
    messageCount: 1,
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
  changed.sessions[0].archived = true;
  assert.notEqual(digestImportPlan(changed).digest, built.digest);
});

