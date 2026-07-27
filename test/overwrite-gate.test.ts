// What may be written over is decided by what is in the file, not by whether its
// bytes still match what the importer recorded.
//
// Claude rewrites a transcript byte-for-byte whenever the conversation is
// opened, so the stored `targetSha256` mismatches for practically every imported
// session — measured over a real 42-record history, 0 of 42 still matched while
// only 20 held anything the user wrote. Gating on the hash therefore means either
// protecting everything or forcing past all of it, and forcing past all of it
// discards 20 real conversations.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { classifyTargetContent, overwriteEligible, type TargetContentClass } from "../src/continued.ts";
import {
  inspectTarget,
  locateTranscript,
  locateTranscriptFrom,
  priorImportsFrom,
  readPriorImports,
  transcriptPathFor,
} from "../src/claude-target.ts";
import { canonicalProjectIdentity, sameProject } from "../src/project-identity.ts";
import { buildImportPlan } from "../src/import-plan.ts";
import { applyForwardSessions, type ForwardSessionApplyPlan } from "../src/claude-forward-target.ts";
import { encodeProjectDir } from "../src/paths.ts";
import { initialTargetVerdict } from "../src/cli.ts";

const IMPORTED_AT_MS = Date.parse("2026-07-13T10:00:00.000Z");
const BEFORE = "2026-07-13T09:59:00.000Z";
const AFTER = "2026-07-25T12:00:00.000Z";

function scratch(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptt-overwrite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** One line the importer itself wrote: Codex-stamped, inert, long before the import. */
function importedLine(text = "history"): Record<string, unknown> {
  return {
    parentUuid: null, isSidechain: false, userType: "external", type: "user",
    sessionId: "s", version: "0.0.0-codex-import", uuid: "u-imported",
    timestamp: BEFORE, isMeta: true,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function typedLine(text: string, timestamp = AFTER): Record<string, unknown> {
  return {
    parentUuid: "u-imported", isSidechain: false, userType: "external", type: "user",
    sessionId: "s", version: "2.0.0", uuid: `u-${text}`, timestamp,
    origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantLine(timestamp = AFTER): Record<string, unknown> {
  return {
    parentUuid: "u-typed", isSidechain: false, userType: "external", type: "assistant",
    sessionId: "s", version: "2.0.0", uuid: "u-assistant", timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "on it" }] },
  };
}

function toolResultLine(timestamp = AFTER): Record<string, unknown> {
  return {
    parentUuid: "u-assistant", isSidechain: false, userType: "external", type: "user",
    sessionId: "s", version: "2.0.0", uuid: "u-tool", timestamp,
    toolUseResult: { stdout: "" },
    message: { role: "user", content: [{ type: "text", text: "[tool result t1]" }] },
  };
}

function writeTranscriptFile(target: string, lines: Record<string, unknown>[]): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const data = lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length ? "\n" : "");
  fs.writeFileSync(target, data, "utf8");
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// The 22-session case: the hash says "modified", the content says nothing of
// yours is in here.
// ---------------------------------------------------------------------------

test("a stale hash does not make an untouched transcript modified", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  writeTranscriptFile(target, [importedLine(), importedLine("more")]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS, {
    expectedSha256: "0".repeat(64), // what the importer recorded; Claude has since rewritten the file
  });

  assert.equal(verdict.sha256Matches, false, "the recorded hash no longer matches");
  assert.equal(verdict.classification, "unchanged");
  assert.equal(verdict.continuation, null);
  assert.equal(verdict.assistantLines, 0);
  assert.ok(overwriteEligible(verdict), "a mismatching hash alone must not protect the file");
});

test("a matching hash does not make a continued transcript unchanged", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  const sha = writeTranscriptFile(target, [importedLine(), typedLine("carry on then")]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS, { expectedSha256: sha });

  assert.equal(verdict.sha256Matches, true, "the bytes are exactly what was recorded");
  assert.equal(verdict.classification, "modified");
  assert.equal(verdict.continuation?.turns, 1);
  assert.equal(verdict.continuation?.firstText, "carry on then");
  assert.equal(overwriteEligible(verdict), false, "one message of the user's is enough to refuse");
});

test("a reply Claude wrote after the import is modification too", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  writeTranscriptFile(target, [importedLine(), assistantLine()]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

  assert.equal(verdict.classification, "modified");
  assert.equal(verdict.assistantLines, 1);
  assert.equal(verdict.continuation, null, "nothing was typed, but something was answered");
  assert.equal(overwriteEligible(verdict), false);
});

test("lines nobody authored are trivial, not modification", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  writeTranscriptFile(target, [importedLine(), toolResultLine()]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

  assert.equal(verdict.classification, "trivial");
  assert.equal(verdict.incidentalLines, 1);
  assert.ok(overwriteEligible(verdict));
});

// Measured over the 42 real imported transcripts: 1196 `last-prompt`, 921
// `custom-title` and 56 `relocated` lines, all of them in a session that had been
// continued and none in the 22 that had not. They carry no timestamp, so nothing
// datable places them, but the importer never writes one.
for (const type of ["last-prompt", "custom-title", "relocated"] as const) {
  test(`an unstamped ${type} line is evidence the session was worked in`, (t) => {
    const root = scratch(t);
    const target = path.join(root, "session.jsonl");
    writeTranscriptFile(target, [importedLine(), { type, value: "whatever the user did" }]);

    const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

    assert.equal(verdict.classification, "modified");
    assert.equal(verdict.markerLines, 1);
    assert.equal(overwriteEligible(verdict), false);
  });
}

test("an unstamped mode line still leaves a transcript unchanged", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  // Claude writes this merely on opening a session; 16 of the 22 untouched
  // transcripts differ from their recorded hash by exactly this and nothing else.
  writeTranscriptFile(target, [importedLine(), { type: "mode", mode: "default" }]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

  assert.equal(verdict.classification, "unchanged");
  assert.equal(verdict.markerLines, 0);
  assert.ok(overwriteEligible(verdict));
});

test("a marker outweighs an otherwise undecidable transcript", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  fs.writeFileSync(
    target,
    `${JSON.stringify(importedLine())}\n{ not json\n${JSON.stringify({ type: "last-prompt", value: "x" })}\n`,
    "utf8",
  );

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

  assert.equal(verdict.classification, "modified");
  assert.equal(overwriteEligible(verdict), false);
});

test("replayed history keeps its Codex stamps and stays unchanged", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  // What Claude writes back when it replays: the same turns, the same old stamps.
  writeTranscriptFile(target, [importedLine(), typedLine("replayed", BEFORE), assistantLine(BEFORE)]);

  assert.equal(classifyTargetContent(target, IMPORTED_AT_MS).classification, "unchanged");
});

test("without an import time nothing can be decided", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  const sha = writeTranscriptFile(target, [importedLine()]);

  const verdict = classifyTargetContent(target, undefined, { expectedSha256: sha });

  assert.equal(verdict.classification, "undecidable");
  assert.match(verdict.undecidable ?? "", /no import time/);
  assert.equal(overwriteEligible(verdict), false, "an exact hash match must not decide it either");
});

test("an unreadable or unparseable transcript is undecidable, never unchanged", (t) => {
  const root = scratch(t);
  const missing = classifyTargetContent(path.join(root, "gone.jsonl"), IMPORTED_AT_MS);
  assert.equal(missing.classification, "undecidable");
  assert.equal(overwriteEligible(missing), false);

  const target = path.join(root, "torn.jsonl");
  fs.writeFileSync(target, `${JSON.stringify(importedLine())}\n{"type":"user",\n`, "utf8");
  const torn = classifyTargetContent(target, IMPORTED_AT_MS);
  assert.equal(torn.classification, "undecidable");
  assert.match(torn.undecidable ?? "", /is not JSON/);
  assert.equal(overwriteEligible(torn), false);
});

test("a message of the user's outweighs a line that cannot be placed", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  fs.writeFileSync(
    target,
    `{"type":"user",\n${JSON.stringify(typedLine("still mine"))}\n`,
    "utf8",
  );

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);
  assert.equal(verdict.classification, "modified", "a torn line must not hide a real turn");
  assert.equal(verdict.continuation?.firstText, "still mine");
});

// ---------------------------------------------------------------------------
// A blanket timestamp rule catches a line of ANY type stamped after the
// import, rather than enumerating which types can carry the user's words —
// enumeration is exactly what let a `queue-operation` enqueue (the user's
// typed message, timestamped, written the instant they submit it — before any
// `user` line exists for it) slip through as "unchanged".
// ---------------------------------------------------------------------------

test("a queue-operation enqueue after the import is modification, not unchanged", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  writeTranscriptFile(target, [
    importedLine(),
    { type: "mode", mode: "default" },
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: AFTER,
      sessionId: "s",
      content: "말하는 설정이란게 뭐 모델인지 steer인지 뭔지",
    },
  ]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

  assert.equal(verdict.classification, "modified");
  assert.equal(overwriteEligible(verdict), false, "the only record of what the user typed must not be discarded");
});

test("a queued-command attachment after the import is modification, not unchanged", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  writeTranscriptFile(target, [
    importedLine(),
    {
      type: "attachment",
      timestamp: AFTER,
      attachment: { type: "queued_command", prompt: "run the tests" },
    },
  ]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

  assert.equal(verdict.classification, "modified");
  assert.equal(overwriteEligible(verdict), false);
});

test("any unrecognized line stamped after the import is modification, not unchanged", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  writeTranscriptFile(target, [
    importedLine(),
    { type: "some-future-line-type-nobody-enumerated-yet", timestamp: AFTER, value: "whatever" },
  ]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

  assert.equal(verdict.classification, "modified");
  assert.equal(overwriteEligible(verdict), false);
});

test("a bare local-time timestamp is untrustworthy, not a usable stamp", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  // No trailing Z or numeric offset: Date.parse would read this as local time,
  // which on a UTC+9 machine could shift it 9 hours earlier and hide a real
  // continuation rather than flag it. It must be treated as unplaceable.
  writeTranscriptFile(target, [importedLine(), typedLine("mine", "2026-07-25T12:00:00.000")]);

  const verdict = classifyTargetContent(target, IMPORTED_AT_MS);

  assert.equal(verdict.classification, "undecidable");
  assert.equal(overwriteEligible(verdict), false);
});

// ---------------------------------------------------------------------------
// `location.state === "absent"` must not be trusted blindly: the directory
// scan behind it swallows its own read errors into an empty result, which can
// report "absent" for a transcript that is actually sitting at `targetPath`.
// ---------------------------------------------------------------------------

test("a file that exists is not synthesized as unchanged just because the location scan reports absent", (t) => {
  const root = scratch(t);
  const target = path.join(root, "session.jsonl");
  // Content that, if read, would be MODIFIED (a real continuation) — chosen so
  // that a wrongly-synthesized "unchanged" verdict is unambiguously wrong here.
  const sha = writeTranscriptFile(target, [importedLine(), typedLine("still here")]);
  assert.equal(inspectTarget(target, sha), "ours", "the file genuinely exists");

  // Simulate what `locateTranscriptFrom` reports when its directory scan
  // failed and was swallowed to an empty result: "absent", despite the file
  // being right there at targetPath.
  const verdict = initialTargetVerdict(
    { state: "absent" },
    inspectTarget(target, sha),
    target,
    IMPORTED_AT_MS,
    sha,
  );

  assert.notEqual(verdict.classification, "unchanged", "a live continuation must never be synthesized away");
  assert.equal(verdict.classification, "modified");
  assert.equal(overwriteEligible(verdict), false);
});

test("initialTargetVerdict still synthesizes unchanged when nothing is genuinely there", (t) => {
  const root = scratch(t);
  const target = path.join(root, "gone.jsonl");

  const verdict = initialTargetVerdict({ state: "absent" }, "absent", target, IMPORTED_AT_MS, null);

  assert.equal(verdict.classification, "unchanged");
  assert.ok(overwriteEligible(verdict));
});

// ---------------------------------------------------------------------------
// Relocation: a transcript found somewhere the project root does not imply is a
// verdict of its own, never "absent, safe to create".
// ---------------------------------------------------------------------------

test("a transcript under another project directory is relocated, not absent", (t) => {
  const claudeHome = scratch(t);
  const sessionId = "019f8a94-aa70-7b82-bfdd-b414b59aabe5";
  const recordedRoot = path.join(claudeHome, "src", "Widget-New");
  // Claude kept the conversation under a different project entirely.
  const actualRoot = path.join(claudeHome, "src", "widget");
  const actual = transcriptPathFor(claudeHome, actualRoot, sessionId);
  writeTranscriptFile(actual, [importedLine(), typedLine("very much alive")]);

  const derived = transcriptPathFor(claudeHome, recordedRoot, sessionId);
  assert.equal(fs.existsSync(derived), false, "nothing is where the project root says");

  const location = locateTranscript(claudeHome, recordedRoot, sessionId);
  assert.notEqual(location.state, "absent", "path-trusting logic would create a stub here");
  assert.equal(location.state, "relocated");
  assert.deepEqual(location.relocatedPaths, [actual]);
  assert.equal(location.expectedPath, derived);
});

test("a transcript where the project root says is at-expected", (t) => {
  const claudeHome = scratch(t);
  const sessionId = "abc";
  const root = path.join(claudeHome, "src", "widget");
  writeTranscriptFile(transcriptPathFor(claudeHome, root, sessionId), [importedLine()]);

  const location = locateTranscript(claudeHome, root, sessionId);
  assert.equal(location.state, "at-expected");
  assert.deepEqual(location.relocatedPaths, []);
});

test("no transcript anywhere is genuinely absent", (t) => {
  const claudeHome = scratch(t);
  fs.mkdirSync(path.join(claudeHome, "projects"), { recursive: true });
  const location = locateTranscript(claudeHome, path.join(claudeHome, "src", "widget"), "nope");
  assert.equal(location.state, "absent");
  assert.deepEqual(location.foundPaths, []);
});

test("apply refuses to write while the conversation lives elsewhere", (t) => {
  const claudeHome = scratch(t);
  const sessionId = "019f8a94-aa70-7b82-bfdd-b414b59aabe5";
  const recordedRoot = path.join(claudeHome, "src", "Widget-New");
  const actualRoot = path.join(claudeHome, "src", "widget");
  writeTranscriptFile(
    transcriptPathFor(claudeHome, actualRoot, sessionId),
    [importedLine(), typedLine("very much alive")],
  );

  const targetPath = transcriptPathFor(claudeHome, recordedRoot, sessionId);
  const afterContents = `${JSON.stringify(importedLine("fresh"))}\n`;
  const session: ForwardSessionApplyPlan = {
    sessionId,
    operationId: "00000000-0000-4000-8000-000000000000",
    sourceSha256: "0".repeat(64),
    transcript: {
      path: targetPath,
      beforeSha256: null, // nothing at the derived path: "absent, safe to create"
      afterSha256: createHash("sha256").update(afterContents, "utf8").digest("hex"),
      afterContents,
    },
    wrapper: null,
  };

  for (const allowOverwrite of [false, true]) {
    assert.throws(
      () => applyForwardSessions([session], {
        bridgeRoot: path.join(claudeHome, "bridge"),
        claudeHome,
        workspaceDir: null,
        planDigest: "d".repeat(64),
        allowOverwrite,
      }),
      /already exists outside the planned project directory/,
      `--allow-overwrite=${allowOverwrite} must not authorize orphaning it`,
    );
  }
  assert.equal(fs.existsSync(targetPath), false, "nothing was created at the derived path");
});

// ---------------------------------------------------------------------------
// A drive letter has no case of its own.
// ---------------------------------------------------------------------------

test("c: and C: are one project identity", () => {
  const lower = String.raw`c:\_projects\Widget`;
  const upper = String.raw`C:\_projects\Widget`;

  const a = canonicalProjectIdentity(lower);
  const b = canonicalProjectIdentity(upper);

  assert.equal(a.key, b.key, "comparison keys must agree");
  assert.equal(a.path, b.path, "and so must the path the plan records");
  assert.ok(sameProject(lower, upper));
  assert.equal(encodeProjectDir(lower), encodeProjectDir(upper), "one Claude project directory");
});

test("a plan does not split into two projects over a drive letter", () => {
  const lower = String.raw`c:\_projects\Widget`;
  const upper = String.raw`C:\_projects\Widget`;
  const base = { archiveState: "active" as const, projectMembership: "project" as const };

  const left = buildImportPlan([{ sessionId: "s1", projectRoot: lower, ...base }]);
  const right = buildImportPlan([{ sessionId: "s1", projectRoot: upper, ...base }]);

  assert.equal(left.plan.sessions[0]!.projectPath, right.plan.sessions[0]!.projectPath);
  assert.equal(left.plan.sessions[0]!.projectKey, right.plan.sessions[0]!.projectKey);
  assert.equal(left.digest, right.digest, "the same project must not produce two plans");

  const both = buildImportPlan([
    { sessionId: "s1", projectRoot: lower, ...base },
    { sessionId: "s2", projectRoot: upper, ...base },
  ]);
  assert.equal(
    new Set(both.plan.sessions.map((session) => session.projectPath)).size,
    1,
    "two spellings, one project folder",
  );
});

// ---------------------------------------------------------------------------
// Every verdict is one of four, and only two of them permit a write.
// ---------------------------------------------------------------------------

test("every classification is one of the four, and only two are eligible", (t) => {
  const root = scratch(t);
  const cases: Array<[string, Record<string, unknown>[] | null, boolean]> = [
    ["unchanged", [importedLine()], true],
    ["trivial", [importedLine(), toolResultLine()], true],
    ["modified", [importedLine(), typedLine("mine")], false],
    ["undecidable", null, false],
  ];
  for (const [expected, lines, eligible] of cases) {
    const target = path.join(root, `${expected}.jsonl`);
    if (lines != null) writeTranscriptFile(target, lines);
    const verdict = classifyTargetContent(target, IMPORTED_AT_MS);
    assert.equal(verdict.classification, expected);
    assert.equal(overwriteEligible(verdict), eligible);
    assert.ok(["unchanged", "modified", "trivial", "undecidable"].includes(verdict.classification));
  }
});

test("locateTranscriptFrom tolerates a Claude home with no projects directory", (t) => {
  const root = scratch(t);
  const location = locateTranscriptFrom(root, path.join(root, "projects", "p", "s.jsonl"), "s");
  assert.equal(location.state, "absent");
});

// ---------------------------------------------------------------------------
// The forward pipeline carries the same verdict the classifier reaches, so the
// converter worth re-importing with is no longer the one that cannot tell a
// continued conversation from an untouched one.
// ---------------------------------------------------------------------------

/** The gate's own refusals, as opposed to anything that goes wrong after it. */
const GATE_REFUSAL = /requires --allow-overwrite|will not be overwritten/;

function gateRefusal(
  claudeHome: string,
  session: ForwardSessionApplyPlan,
  held: TargetContentClass | undefined,
  allowOverwrite: boolean,
): string | null {
  try {
    applyForwardSessions([session], {
      bridgeRoot: path.join(claudeHome, "bridge"),
      claudeHome,
      workspaceDir: null,
      planDigest: "d".repeat(64),
      allowOverwrite,
      targetContent: held == null ? undefined : new Map([[session.sessionId, held]]),
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return GATE_REFUSAL.test(message) ? message : null;
  }
}

function existingTarget(t: { after: (fn: () => void) => void }): {
  claudeHome: string;
  session: ForwardSessionApplyPlan;
} {
  const claudeHome = scratch(t);
  const cwd = String.raw`C:\_projects\Widget`;
  const sessionId = "019f0000-0000-7000-8000-00000000beef";
  const targetPath = transcriptPathFor(claudeHome, cwd, sessionId);
  const before = `${JSON.stringify(importedLine())}\n`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, before, "utf8");
  const afterContents = `${JSON.stringify(importedLine("re-rendered"))}\n`;
  return {
    claudeHome,
    session: {
      sessionId,
      operationId: "00000000-0000-4000-8000-000000000000",
      sourceSha256: "0".repeat(64),
      transcript: {
        path: targetPath,
        beforeSha256: createHash("sha256").update(before, "utf8").digest("hex"),
        afterSha256: createHash("sha256").update(afterContents, "utf8").digest("hex"),
        afterContents,
      },
      wrapper: null,
    },
  };
}

for (const held of ["unchanged", "trivial"] as const) {
  test(`a transcript holding only the import is written without --allow-overwrite (${held})`, (t) => {
    const { claudeHome, session } = existingTarget(t);
    assert.equal(gateRefusal(claudeHome, session, held, false), null);
  });
}

test("a continued transcript is refused whether or not the flag is passed", (t) => {
  const { claudeHome, session } = existingTarget(t);
  for (const allowOverwrite of [false, true]) {
    assert.match(
      gateRefusal(claudeHome, session, "modified", allowOverwrite) ?? "",
      /will not be overwritten/,
      `--allow-overwrite=${allowOverwrite} must not authorize discarding it`,
    );
  }
});

test("a session the history says nothing about still needs the flag", (t) => {
  const { claudeHome, session } = existingTarget(t);
  assert.match(gateRefusal(claudeHome, session, undefined, false) ?? "", /requires --allow-overwrite/);
  assert.equal(gateRefusal(claudeHome, session, undefined, true), null);
});

test("a history that cannot be read leaves every session undecidable, never safe", (t) => {
  const root = scratch(t);
  const absent = readPriorImports(path.join(root, "no-such-home"));
  assert.equal(absent.size, 0);

  const malformed = path.join(root, "malformed");
  fs.mkdirSync(malformed, { recursive: true });
  fs.writeFileSync(path.join(malformed, "codex-import-history.json"), "{ not json", "utf8");
  assert.equal(readPriorImports(malformed).size, 0);

  // A record that cannot say which session it is, or when, is not evidence either.
  assert.equal(priorImportsFrom({ version: 1, records: [
    { importedSessionId: "", importedAtMs: 1 },
    { importedSessionId: "s", importedAtMs: Number.NaN },
    { importedSessionId: "s2", importedAtMs: 5, targetSha256: "a".repeat(64) },
  ] } as never).size, 1);
});
