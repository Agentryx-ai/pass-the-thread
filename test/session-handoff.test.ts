import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  MAX_HANDOFF_BODY_BYTES,
  MAX_HANDOFF_HEADER_BYTES,
  createSessionHandoffHeader,
  currentHandoffProjectIdentity,
  inspectSessionHandoffHeader,
  readSessionHandoff,
  resolveSessionHandoff,
} from "../src/session-handoff.ts";

function temp(t: TestContext, prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initGit(root: string): void {
  git(root, "init");
  git(root, "config", "user.email", "threadpass@example.invalid");
  git(root, "config", "user.name", "Threadpass Test");
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", "seed.txt");
  git(root, "commit", "-m", "seed");
}

function save(
  directory: string,
  name: string,
  cwd: string,
  savedAt: string,
  body = "# Session\nbody\n",
): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, createSessionHandoffHeader({ cwd, savedAt }) + body);
  return fs.realpathSync.native(file);
}

test("Git identity uses canonical worktree root and per-worktree git dir", (t) => {
  const root = temp(t, "threadpass-handoff-git-");
  initGit(root);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);

  const fromRoot = currentHandoffProjectIdentity(root);
  const fromNested = currentHandoffProjectIdentity(nested);
  assert.deepEqual(fromNested, fromRoot);
  assert.equal(fromRoot.kind, "git");
  if (fromRoot.kind === "git") {
    assert.equal(fromRoot.root, fs.realpathSync.native(root));
    assert.equal(fromRoot.gitDir, fs.realpathSync.native(path.join(root, ".git")));
  }
});

test("same Git worktree accepts root and nested cwd; linked worktree and clone reject", (t) => {
  const fixture = temp(t, "threadpass-handoff-worktrees-");
  const main = path.join(fixture, "main");
  const linked = path.join(fixture, "linked");
  const clone = path.join(fixture, "clone");
  const sessions = path.join(fixture, "sessions");
  fs.mkdirSync(main);
  fs.mkdirSync(sessions);
  initGit(main);
  git(main, "worktree", "add", "-b", "linked-test", linked);
  git(fixture, "clone", main, clone);
  const file = save(sessions, "same-session.tmp", main, "2026-07-27T01:00:00.000Z");

  assert.equal(resolveSessionHandoff({ cwd: path.join(main), sessionDirectories: [sessions] }).resolvedPath, file);
  fs.mkdirSync(path.join(main, "deep"));
  assert.equal(resolveSessionHandoff({ cwd: path.join(main, "deep"), sessionDirectories: [sessions] }).resolvedPath, file);
  assert.equal(resolveSessionHandoff({ cwd: linked, sessionDirectories: [sessions] }).verdict, "no-match");
  assert.equal(resolveSessionHandoff({ cwd: clone, sessionDirectories: [sessions] }).verdict, "no-match");
});

test("non-Git identity accepts only the exact canonical current directory", (t) => {
  const fixture = temp(t, "threadpass-handoff-directories-");
  const parent = path.join(fixture, "parent");
  const project = path.join(parent, "project");
  const child = path.join(project, "child");
  const sibling = path.join(parent, "sibling");
  const sessions = path.join(fixture, "sessions");
  for (const dir of [parent, project, child, sibling, sessions]) fs.mkdirSync(dir, { recursive: true });
  const file = save(sessions, "directory-session.tmp", project, "2026-07-27T02:00:00.000Z");

  assert.equal(resolveSessionHandoff({ cwd: project, sessionDirectories: [sessions] }).resolvedPath, file);
  for (const cwd of [parent, child, sibling]) {
    assert.equal(resolveSessionHandoff({ cwd, sessionDirectories: [sessions] }).verdict, "no-match");
  }
});

test("default and date selection filter exact identity before newest sorting", (t) => {
  const fixture = temp(t, "threadpass-handoff-selection-");
  const exact = path.join(fixture, "exact");
  const foreign = path.join(fixture, "foreign");
  const sessions = path.join(fixture, "sessions");
  for (const dir of [exact, foreign, sessions]) fs.mkdirSync(dir);
  const olderExact = save(sessions, "z-exact-session.tmp", exact, "2026-07-27T02:00:00.000Z");
  save(sessions, "foreign-session.tmp", foreign, "2026-07-27T09:00:00.000Z");

  assert.equal(resolveSessionHandoff({ cwd: exact, sessionDirectories: [sessions] }).resolvedPath, olderExact);
  assert.equal(resolveSessionHandoff({ cwd: exact, date: "2026-07-27", sessionDirectories: [sessions] }).resolvedPath, olderExact);
  assert.equal(resolveSessionHandoff({ cwd: temp(t, "threadpass-handoff-none-"), sessionDirectories: [sessions] }).verdict, "no-match");
  assert.equal(resolveSessionHandoff({ cwd: exact, date: "2026-02-30", sessionDirectories: [sessions] }).verdict, "rejected");
});

test("savedAt ties use canonical absolute path ordinal ordering", (t) => {
  const fixture = temp(t, "threadpass-handoff-tie-");
  const project = path.join(fixture, "project");
  const sessions = path.join(fixture, "sessions");
  fs.mkdirSync(project);
  fs.mkdirSync(sessions);
  const b = save(sessions, "b-session.tmp", project, "2026-07-27T03:00:00.000Z");
  const a = save(sessions, "a-session.tmp", project, "2026-07-27T03:00:00.000Z");
  const expected = [a, b].map((item) => fs.realpathSync.native(item)).sort()[0];
  assert.equal(resolveSessionHandoff({ cwd: project, sessionDirectories: [sessions] }).resolvedPath, expected);
});

test("explicit cross-project and legacy files require both file and override flag", (t) => {
  const fixture = temp(t, "threadpass-handoff-explicit-");
  const current = path.join(fixture, "current");
  const foreign = path.join(fixture, "foreign");
  fs.mkdirSync(current);
  fs.mkdirSync(foreign);
  const foreignFile = save(fixture, "foreign-session.tmp", foreign, "2026-07-27T04:00:00.000Z");
  const legacyFile = path.join(fixture, "legacy-session.tmp");
  fs.writeFileSync(legacyFile, "# Legacy session\nbody\n");

  assert.equal(resolveSessionHandoff({ cwd: current, explicitFile: foreignFile }).verdict, "rejected");
  const allowedForeign = resolveSessionHandoff({ cwd: current, explicitFile: foreignFile, allowCrossProject: true });
  assert.equal(allowedForeign.verdict, "accepted");
  assert.match(allowedForeign.warnings.join("\n"), /cross-project/i);
  assert.equal(resolveSessionHandoff({ cwd: current, explicitFile: legacyFile }).verdict, "rejected");
  const allowedLegacy = resolveSessionHandoff({ cwd: current, explicitFile: legacyFile, allowCrossProject: true });
  assert.equal(allowedLegacy.verdict, "accepted");
  assert.equal(allowedLegacy.bodyOffset, 0);
  assert.match(allowedLegacy.warnings.join("\n"), /legacy|headerless/i);
  assert.equal(resolveSessionHandoff({ cwd: current, sessionDirectories: [fixture], allowCrossProject: true }).verdict, "rejected");
});

test("an explicit override accepts a structurally valid stale recorded identity", (t) => {
  const fixture = temp(t, "threadpass-handoff-stale-");
  const moved = path.join(fixture, "before-move");
  const current = path.join(fixture, "current");
  fs.mkdirSync(moved);
  fs.mkdirSync(current);
  const file = save(fixture, "stale-session.tmp", moved, "2026-07-27T04:30:00.000Z");
  fs.renameSync(moved, path.join(fixture, "after-move"));

  assert.equal(resolveSessionHandoff({ cwd: current, sessionDirectories: [fixture] }).verdict, "no-match");
  assert.equal(resolveSessionHandoff({ cwd: current, explicitFile: file }).verdict, "rejected");
  assert.equal(resolveSessionHandoff({ cwd: current, explicitFile: file, allowCrossProject: true }).verdict, "accepted");
});

test("malformed, oversized, unterminated, and unsupported headers always reject", (t) => {
  const fixture = temp(t, "threadpass-handoff-invalid-");
  const current = path.join(fixture, "current");
  fs.mkdirSync(current);
  const cases: Array<[string, string]> = [
    ["old-prototype", "<!-- threadpass-handoff:v1\n{}\n-->\nbody"],
    ["malformed", "<!-- threadpass-handoff:v1\n{nope}\n-->\nbody"],
    ["unterminated", "<!-- threadpass-handoff:v1\n{}\nbody"],
    ["oversized", `<!-- threadpass-handoff:v1\n${"x".repeat(MAX_HANDOFF_HEADER_BYTES)}\n-->\nbody`],
    ["unsupported", "<!-- threadpass-handoff:v2\n{}\n-->\nbody"],
  ];
  for (const [name, contents] of cases) {
    const file = path.join(fixture, `${name}-session.tmp`);
    fs.writeFileSync(file, contents);
    const inspected = inspectSessionHandoffHeader(file);
    assert.equal(inspected.kind, "invalid", name);
    assert.equal(resolveSessionHandoff({ cwd: current, explicitFile: file, allowCrossProject: true }).verdict, "rejected", name);
  }
});

test("framed header scanning is bounded to two reads per malformed candidate", (t) => {
  const fixture = temp(t, "threadpass-handoff-many-");
  const current = path.join(fixture, "current");
  const sessions = path.join(fixture, "sessions");
  fs.mkdirSync(current);
  fs.mkdirSync(sessions);
  const framed = "<!-- threadpass-handoff:v1;bytes=00001\nx\n-->\nBODY_SENTINEL";
  for (let index = 0; index < 100; index += 1) {
    fs.writeFileSync(path.join(sessions, `${String(index).padStart(3, "0")}-session.tmp`), framed);
  }
  const prefixBytes = Buffer.byteLength("<!-- threadpass-handoff:v1;bytes=00000\n");
  const headerBytes = prefixBytes + 1 + Buffer.byteLength("\n-->\n");
  const requests: Array<{ length: number; position: number | null }> = [];
  const originalReadSync = fs.readSync;
  Object.defineProperty(fs, "readSync", {
    configurable: true,
    value: (...args: unknown[]) => {
      requests.push({ length: args[3] as number, position: args[4] as number | null });
      return Reflect.apply(originalReadSync, fs, args);
    },
  });
  let result;
  try {
    result = resolveSessionHandoff({ cwd: current, sessionDirectories: [sessions] });
  } finally {
    Object.defineProperty(fs, "readSync", { configurable: true, value: originalReadSync });
  }
  assert.equal(result.verdict, "rejected");
  assert.equal(result.rejectedCandidates.length, 100);
  assert.ok(result.rejectedCandidates.every((candidate) =>
    /header JSON is malformed/i.test(candidate.reason) && candidate.path.endsWith("-session.tmp")));
  assert.match(result.reason ?? "", /100 candidate\(s\) failed header inspection/);
  assert.ok(requests.length <= 200, `expected <= 200 reads, got ${requests.length}`);
  assert.ok(requests.every((request) =>
    request.position !== null && request.position + request.length <= headerBytes));
});

test("resolver reads through the header terminator only, never a huge foreign body", (t) => {
  const fixture = temp(t, "threadpass-handoff-bounded-");
  const current = path.join(fixture, "current");
  const foreign = path.join(fixture, "foreign");
  fs.mkdirSync(current);
  fs.mkdirSync(foreign);
  const sentinel = "BODY_SENTINEL_MUST_NOT_APPEAR";
  const file = save(fixture, "huge-session.tmp", foreign, "2026-07-27T05:00:00.000Z", sentinel + "x".repeat(2_000_000));
  const expectedOffset = Buffer.byteLength(createSessionHandoffHeader({ cwd: foreign, savedAt: "2026-07-27T05:00:00.000Z" }));
  const readRequests: Array<{ length: number; position: number | null }> = [];
  const originalReadSync = fs.readSync;
  Object.defineProperty(fs, "readSync", {
    configurable: true,
    value: (...args: unknown[]) => {
      readRequests.push({ length: args[3] as number, position: args[4] as number | null });
      return Reflect.apply(originalReadSync, fs, args);
    },
  });
  let resolved;
  try {
    resolved = resolveSessionHandoff({ cwd: current, explicitFile: file });
  } finally {
    Object.defineProperty(fs, "readSync", { configurable: true, value: originalReadSync });
  }
  assert.equal(resolved.verdict, "rejected");
  assert.doesNotMatch(JSON.stringify(resolved), new RegExp(sentinel));
  assert.ok(readRequests.length > 0);
  assert.ok(readRequests.every((request) =>
    request.position !== null && request.position + request.length <= expectedOffset));
});

test("read accepts the exact body limit and rejects one byte beyond it before allocation", (t) => {
  const fixture = temp(t, "threadpass-handoff-body-limit-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const exact = save(
    fixture,
    "exact-session.tmp",
    project,
    "2026-07-27T05:10:00.000Z",
    "x".repeat(MAX_HANDOFF_BODY_BYTES),
  );
  const accepted = readSessionHandoff({ cwd: project, explicitFile: exact });
  assert.equal(accepted.verdict, "accepted");
  assert.equal(Buffer.byteLength(accepted.body ?? ""), MAX_HANDOFF_BODY_BYTES);

  const over = save(
    fixture,
    "over-session.tmp",
    project,
    "2026-07-27T05:11:00.000Z",
    "x".repeat(MAX_HANDOFF_BODY_BYTES + 1),
  );
  const rejected = readSessionHandoff({ cwd: project, explicitFile: over });
  assert.equal(rejected.verdict, "rejected");
  assert.equal(rejected.body, null);
  assert.match(rejected.reason ?? "", /body exceeds/i);
});

test("CLI rejects a sparse huge body without materializing or serializing it", (t) => {
  const fixture = temp(t, "threadpass-handoff-sparse-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const entrypoint = path.resolve("src", "threadpass.ts");
  const header = createSessionHandoffHeader({ cwd: project, savedAt: "2026-07-27T05:20:00.000Z" });
  const file = path.join(fixture, "sparse-session.tmp");
  fs.writeFileSync(file, header);
  if (process.platform === "win32") {
    // Node's truncateSync never issues FSCTL_SET_SPARSE, so NTFS would physically allocate the gigabyte.
    const flagged = spawnSync("fsutil", ["sparse", "setflag", file], { encoding: "utf8", windowsHide: true });
    if (flagged.status !== 0) {
      t.skip(`fsutil sparse setflag is unavailable; refusing to allocate a real gigabyte: ${flagged.stderr || flagged.error}`);
      return;
    }
  }
  fs.truncateSync(file, Buffer.byteLength(header) + MAX_HANDOFF_BODY_BYTES + 1024 ** 3);
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--experimental-sqlite", entrypoint, "handoff", "read", "--cwd", project, "--file", file],
    { cwd: path.resolve("."), encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout) as { verdict: string; body: null; reason: string };
  assert.equal(parsed.verdict, "rejected");
  assert.equal(parsed.body, null);
  assert.match(parsed.reason, /body exceeds/i);
});

test("short-read retries are bounded and fail closed without reaching the body", (t) => {
  const fixture = temp(t, "threadpass-handoff-short-read-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const file = save(fixture, "short-session.tmp", project, "2026-07-27T05:25:00.000Z", "BODY_SENTINEL");
  const originalReadSync = fs.readSync;
  const positions: number[] = [];
  Object.defineProperty(fs, "readSync", {
    configurable: true,
    value: (...args: unknown[]) => {
      const position = args[4] as number;
      positions.push(position);
      return Reflect.apply(originalReadSync, fs, [args[0], args[1], args[2], 1, position]);
    },
  });
  let result;
  try {
    result = readSessionHandoff({ cwd: project, explicitFile: file });
  } finally {
    Object.defineProperty(fs, "readSync", { configurable: true, value: originalReadSync });
  }
  assert.equal(result.verdict, "rejected");
  assert.match(result.reason ?? "", /short-read retry limit/i);
  assert.ok(positions.length <= 16, `expected a bounded retry count, got ${positions.length}`);
  assert.ok(positions.every((position) => position < Buffer.byteLength("<!-- threadpass-handoff:v1;bytes=00000\n")));
});

test("pure pathname replacement is accepted only when the opened inode ctime stays stable", (t) => {
  const fixture = temp(t, "threadpass-handoff-race-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const originalBody = "# Original accepted body\n";
  const file = save(fixture, "race-session.tmp", project, "2026-07-27T05:30:00.000Z", originalBody);
  const replacement = path.join(fixture, "replacement.tmp");
  fs.writeFileSync(replacement, createSessionHandoffHeader({ cwd: project, savedAt: "2026-07-27T05:31:00.000Z" }) + "# Replacement body\n");

  const before = fs.statSync(file, { bigint: true });
  let renamedCtimeChanged = false;
  const result = readSessionHandoff({
    cwd: project,
    explicitFile: file,
    testingBeforeBodyRead: () => {
      const acceptedPath = path.join(fixture, "accepted-open-file.tmp");
      fs.renameSync(file, acceptedPath);
      renamedCtimeChanged = fs.statSync(acceptedPath, { bigint: true }).ctimeNs !== before.ctimeNs;
      fs.renameSync(replacement, file);
    },
  });
  assert.equal(result.verdict, renamedCtimeChanged ? "rejected" : "accepted");
  assert.equal(result.body, renamedCtimeChanged ? null : originalBody);
  if (renamedCtimeChanged) assert.match(result.reason ?? "", /changed while/i);
  else assert.ok(result.snapshot);
  assert.match(fs.readFileSync(file, "utf8"), /Replacement body/);
});

test("read rejects an edited opened inode after mtime restore and pathname replacement", (t) => {
  const fixture = temp(t, "threadpass-handoff-ctime-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const savedAt = "2026-07-27T05:40:00.000Z";
  const originalBody = "# Original body A\n";
  const editedBody = "# Modified body B\n";
  assert.equal(Buffer.byteLength(originalBody), Buffer.byteLength(editedBody));
  const file = save(fixture, "ctime-session.tmp", project, savedAt, originalBody);
  const fixedTime = new Date("2026-07-27T05:45:00.123Z");
  fs.utimesSync(file, fixedTime, fixedTime);
  const before = fs.statSync(file, { bigint: true });
  const header = createSessionHandoffHeader({ cwd: project, savedAt });
  const replacement = path.join(fixture, "replacement.tmp");
  fs.writeFileSync(replacement, createSessionHandoffHeader({ cwd: project, savedAt: "2026-07-27T05:41:00.000Z" }) + "# Replacement body\n");

  const result = readSessionHandoff({
    cwd: project,
    explicitFile: file,
    testingBeforeBodyRead: () => {
      fs.writeFileSync(file, header + editedBody);
      fs.utimesSync(file, fixedTime, fixedTime);
      const restored = fs.statSync(file, { bigint: true });
      assert.equal(restored.ino, before.ino);
      assert.equal(restored.size, before.size);
      assert.equal(restored.mtimeNs, before.mtimeNs);
      assert.notEqual(restored.ctimeNs, before.ctimeNs);
      fs.renameSync(file, path.join(fixture, "edited-open-file.tmp"));
      fs.renameSync(replacement, file);
    },
  });
  assert.equal(result.verdict, "rejected");
  assert.equal(result.body, null);
  assert.match(result.reason ?? "", /changed while/i);
});

test("resolve checks the accepted descriptor again after a pure pathname replacement", (t) => {
  const fixture = temp(t, "threadpass-resolve-path-race-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const file = save(fixture, "resolve-race-session.tmp", project, "2026-07-27T06:00:00.000Z", "# Original\n");
  const replacement = path.join(fixture, "replacement.tmp");
  fs.writeFileSync(replacement, createSessionHandoffHeader({ cwd: project, savedAt: "2026-07-27T06:01:00.000Z" }) + "# Replacement\n");
  const before = fs.statSync(file, { bigint: true });
  let renamedCtimeChanged = false;
  const result = resolveSessionHandoff({
    cwd: project,
    explicitFile: file,
    testingBeforeResolveReturn: () => {
      const acceptedPath = path.join(fixture, "accepted-resolve-file.tmp");
      fs.renameSync(file, acceptedPath);
      renamedCtimeChanged = fs.statSync(acceptedPath, { bigint: true }).ctimeNs !== before.ctimeNs;
      fs.renameSync(replacement, file);
    },
  });
  assert.equal(result.verdict, renamedCtimeChanged ? "rejected" : "accepted");
  if (renamedCtimeChanged) assert.match(result.reason ?? "", /changed while/i);
});

test("resolve rejects a same-size header edit after mtime restore and pathname replacement", (t) => {
  const fixture = temp(t, "threadpass-resolve-header-race-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const originalSavedAt = "2026-07-27T06:10:00.000Z";
  const editedSavedAt = "2026-07-27T06:11:00.000Z";
  const body = "# Resolve body\n";
  const file = save(fixture, "resolve-header-session.tmp", project, originalSavedAt, body);
  const fixedTime = new Date("2026-07-27T06:15:00.123Z");
  fs.utimesSync(file, fixedTime, fixedTime);
  const before = fs.statSync(file, { bigint: true });
  const edited = createSessionHandoffHeader({ cwd: project, savedAt: editedSavedAt }) + body;
  assert.equal(Buffer.byteLength(edited), Number(before.size));
  const replacement = path.join(fixture, "replacement.tmp");
  fs.writeFileSync(replacement, createSessionHandoffHeader({ cwd: project, savedAt: "2026-07-27T06:12:00.000Z" }) + body);

  const result = resolveSessionHandoff({
    cwd: project,
    explicitFile: file,
    testingBeforeResolveReturn: () => {
      fs.writeFileSync(file, edited);
      fs.utimesSync(file, fixedTime, fixedTime);
      const restored = fs.statSync(file, { bigint: true });
      assert.equal(restored.ino, before.ino);
      assert.equal(restored.size, before.size);
      assert.equal(restored.mtimeNs, before.mtimeNs);
      assert.notEqual(restored.ctimeNs, before.ctimeNs);
      fs.renameSync(file, path.join(fixture, "edited-resolve-file.tmp"));
      fs.renameSync(replacement, file);
    },
  });
  assert.equal(result.verdict, "rejected");
  assert.match(result.reason ?? "", /changed while/i);
});

test("current identity fails closed for missing paths and non-directories", (t) => {
  const fixture = temp(t, "threadpass-handoff-current-");
  assert.throws(() => currentHandoffProjectIdentity(path.join(fixture, "missing")), /exist/i);
  const file = path.join(fixture, "file");
  fs.writeFileSync(file, "x");
  assert.throws(() => currentHandoffProjectIdentity(file), /directory/i);
});

test("current identity fails closed when Git classification is unavailable", (t) => {
  const fixture = temp(t, "threadpass-handoff-no-git-");
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.throws(
      () => currentHandoffProjectIdentity(fixture),
      /unable to classify current directory as Git or non-Git/i,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("threadpass handoff CLI emits raw headers and structured resolver JSON", (t) => {
  const fixture = temp(t, "threadpass-handoff-cli-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const entrypoint = path.resolve("src", "threadpass.ts");
  const nodeArgs = ["--experimental-strip-types", "--experimental-sqlite", entrypoint, "handoff"];
  const header = spawnSync(process.execPath, [...nodeArgs, "header", "--cwd", project, "--saved-at", "2026-07-27T06:00:00.000Z"], {
    cwd: path.resolve("."), encoding: "utf8",
  });
  assert.equal(header.status, 0, header.stderr);
  assert.match(header.stdout, /^<!-- threadpass-handoff:v1;bytes=\d{5}\n/);
  const file = path.join(fixture, "cli-session.tmp");
  fs.writeFileSync(file, header.stdout + "# Body\n");
  const resolved = spawnSync(process.execPath, [...nodeArgs, "resolve", "--cwd", project, "--file", file], {
    cwd: path.resolve("."), encoding: "utf8",
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  const result = JSON.parse(resolved.stdout) as { verdict: string; resolvedPath: string; bodyOffset: number };
  assert.equal(result.verdict, "accepted");
  assert.equal(result.resolvedPath, fs.realpathSync.native(file));
  assert.equal(result.bodyOffset, Buffer.byteLength(header.stdout));

  const read = spawnSync(process.execPath, [...nodeArgs, "read", "--cwd", project, "--file", file], {
    cwd: path.resolve("."), encoding: "utf8",
  });
  assert.equal(read.status, 0, read.stderr);
  const readResult = JSON.parse(read.stdout) as { verdict: string; body: string; snapshot: unknown };
  assert.equal(readResult.verdict, "accepted");
  assert.equal(readResult.body, "# Body\n");
  assert.ok(readResult.snapshot);

  const rejected = spawnSync(process.execPath, [...nodeArgs, "resolve", "--cwd", project, "--allow-cross-project"], {
    cwd: path.resolve("."), encoding: "utf8",
  });
  assert.equal(rejected.status, 1);
  assert.equal((JSON.parse(rejected.stdout) as { verdict: string }).verdict, "rejected");
});

test("a bare handoff invocation still honours the JSON failure contract", () => {
  const entrypoint = path.resolve("src", "threadpass.ts");
  const bare = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", entrypoint, "handoff"], {
    cwd: path.resolve("."), encoding: "utf8",
  });
  assert.equal(bare.status, 1);
  const parsed = JSON.parse(bare.stdout) as { verdict: string; reason: string };
  assert.equal(parsed.verdict, "rejected");
  assert.match(parsed.reason, /subcommand/i);
  assert.match(bare.stderr, /USAGE/);
});

test("a UTF-8 BOM or CRLF framing still reads as a first-class handoff", (t) => {
  const fixture = temp(t, "threadpass-handoff-encoding-");
  const project = path.join(fixture, "project");
  fs.mkdirSync(project);
  const header = createSessionHandoffHeader({ cwd: project, savedAt: "2026-07-27T07:00:00.000Z" });
  const body = "# Body\n";
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const crlf = header.replace(/\n/g, "\r\n");
  const cases: Array<[string, Buffer]> = [
    ["bom", Buffer.concat([bom, Buffer.from(header + body, "utf8")])],
    ["crlf", Buffer.from(crlf + body, "utf8")],
    ["bom-crlf", Buffer.concat([bom, Buffer.from(crlf + body, "utf8")])],
  ];
  for (const [name, contents] of cases) {
    const file = path.join(fixture, `${name}-session.tmp`);
    fs.writeFileSync(file, contents);
    const result = readSessionHandoff({ cwd: project, explicitFile: file });
    assert.equal(result.verdict, "accepted", `${name}: ${result.reason}`);
    assert.equal(result.body, body, name);
  }
});

test("a discovered candidate that fails inspection is reported beside the accepted one", (t) => {
  const fixture = temp(t, "threadpass-handoff-reasons-");
  const project = path.join(fixture, "project");
  const sessions = path.join(fixture, "sessions");
  fs.mkdirSync(project);
  fs.mkdirSync(sessions);
  const good = save(sessions, "good-session.tmp", project, "2026-07-27T07:10:00.000Z");
  const broken = path.join(sessions, "broken-session.tmp");
  fs.writeFileSync(broken, "<!-- threadpass-handoff:v1;bytes=00004\n{nope}\n-->\nbody");
  const result = resolveSessionHandoff({ cwd: project, sessionDirectories: [sessions] });
  assert.equal(result.resolvedPath, good);
  assert.deepEqual(result.rejectedCandidates.map((candidate) => candidate.path), [fs.realpathSync.native(broken)]);
  assert.match(result.rejectedCandidates[0]?.reason ?? "", /terminator|JSON is malformed/i);
});
