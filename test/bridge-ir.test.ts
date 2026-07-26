import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEnvelope, sha256Utf8, stableStringify } from "../src/envelope.ts";
import { readClaudeJsonl, scanClaudeSessions } from "../src/claude-source.ts";
import { claudeRecordToIr, claudeTranscriptToIr } from "../src/claude-to-ir.ts";
import { codexRecordToIr, codexRolloutToBridgeBundle } from "../src/codex-to-ir.ts";
import type { CodexSession } from "../src/types.ts";
import {
  objectPath,
  conversationPath,
  conversationRevisionPath,
  readBridgeConversation,
  writeBridgeConversation,
} from "../src/bridge-store.ts";

const json = (value: unknown): string => JSON.stringify(value);

test("opaque envelopes preserve exact source bytes and use deterministic hashes", () => {
  const raw = json({ type: "future-record", payload: { z: 1 } });
  const a = createEnvelope("claude", raw, {
    sourcePath: "C:/source/session.jsonl",
    recordIndex: 3,
    lineEnding: "\r\n",
  });
  const b = createEnvelope("claude", raw, {
    sourcePath: "C:/source/session.jsonl",
    recordIndex: 3,
    lineEnding: "\r\n",
  });

  assert.deepEqual(a, b);
  assert.equal(a.raw, raw);
  assert.equal(a.lineEnding, "\r\n");
  assert.equal(
    a.contentSha256,
    createHash("sha256").update(raw + "\r\n", "utf8").digest("hex"),
  );
  assert.deepEqual(a.parsed, { type: "future-record", payload: { z: 1 } });

  const malformed = createEnvelope("claude", "{not json", {
    sourcePath: "C:/source/session.jsonl",
    recordIndex: 4,
    lineEnding: "",
  });
  assert.equal(malformed.parsed, undefined);
  assert.equal(typeof malformed.parseError, "string");
  assert.equal(malformed.raw, "{not json");
});

test("Claude JSONL reading never drops malformed records or line endings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-source-"));
  const file = path.join(dir, "session.jsonl");
  const contents = `${json({ type: "user", sessionId: "s1", message: { content: "hello" } })}\r\n{broken\n`;
  fs.writeFileSync(file, contents, "utf8");

  const source = readClaudeJsonl(file);
  assert.equal(source.records.length, 2);
  assert.equal(source.records[0].lineEnding, "\r\n");
  assert.equal(source.records[1].lineEnding, "\n");
  assert.equal(source.records[1].raw, "{broken");
  assert.equal(source.records[1].parsed, undefined);
  assert.equal(source.records.map((record) => record.raw + record.lineEnding).join(""), contents);
  assert.equal(
    source.contentSha256,
    createHash("sha256").update(contents, "utf8").digest("hex"),
  );

  const home = path.join(dir, ".claude");
  const project = path.join(home, "projects", "-repo");
  fs.mkdirSync(project, { recursive: true });
  fs.copyFileSync(file, path.join(project, "s1.jsonl"));
  fs.writeFileSync(path.join(project, "ignore.txt"), "not a transcript");
  assert.deepEqual(scanClaudeSessions(home).map((item) => path.basename(item.sourcePath)), ["s1.jsonl"]);
});

test("invalid UTF-8 is refused instead of being normalized", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-invalid-utf8-"));
  const source = path.join(root, "bad.jsonl");
  fs.writeFileSync(source, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
  assert.throws(() => readClaudeJsonl(source), /not valid UTF-8/);
});

test("a UTF-8 BOM remains reconstructable in the canonical sidecar envelopes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bom-"));
  const sourcePath = path.join(root, "bom.jsonl");
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${json({ type: "user", sessionId: "bom", message: { content: "hello" } })}\r\n`, "utf8"),
  ]);
  fs.writeFileSync(sourcePath, bytes);
  const source = readClaudeJsonl(sourcePath);
  const reconstructed = Buffer.from(source.records.map((record) => record.raw + record.lineEnding).join(""), "utf8");
  assert.deepEqual(reconstructed, bytes);
  assert.equal(source.contentSha256, createHash("sha256").update(bytes).digest("hex"));
});

test("Codex rollouts also get a byte-exact provider-neutral sidecar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sidecar-"));
  const sourcePath = path.join(root, "rollout.jsonl");
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"type":"event_msg","payload":{"type":"goal"}}\r\n{"type":"world_state"}\n', "utf8"),
  ]);
  fs.writeFileSync(sourcePath, bytes);
  const session = {
    sessionId: "codex-sidecar", rolloutPath: sourcePath, cwd: "C:\\repo", cwdOriginal: "C:\\repo",
    meta: {}, firstTsMs: null, lastTsMs: null, items: [], model: null, messageCount: 0,
    title: "sidecar", source: "vscode", isChild: false, userMessageCount: 0,
  } satisfies CodexSession;
  const bundle = codexRolloutToBridgeBundle(session);
  const forged = {
    ...bundle,
    conversation: { ...bundle.conversation, sourceContentSha256: "0".repeat(64) },
  };
  assert.throws(
    () => writeBridgeConversation(path.join(root, "forged-bridge"), forged),
    /source content hash does not match/,
  );
  assert.deepEqual(
    Buffer.from(bundle.envelopes.map((envelope) => envelope.raw + envelope.lineEnding).join(""), "utf8"),
    bytes,
  );
  const guarded = { ...session, sourceContentSha256: bundle.conversation.sourceContentSha256 };
  fs.appendFileSync(sourcePath, "{}\n");
  assert.throws(() => codexRolloutToBridgeBundle(guarded), /changed after it was parsed/);
  fs.writeFileSync(sourcePath, bytes);
  const store = path.join(root, "bridge");
  writeBridgeConversation(store, bundle);
  const restored = readBridgeConversation(store, session.sessionId);
  assert.deepEqual(
    Buffer.from(restored.envelopes.map((envelope) => envelope.raw + envelope.lineEnding).join(""), "utf8"),
    bytes,
  );
});

test("every Codex envelope maps to typed historical IR or an explicit unknown", () => {
  const records = [
    { timestamp: "2026-07-25T10:00:00.000Z", type: "session_meta", payload: { id: "codex-ir", cwd: "C:\\repo" } },
    {
      timestamp: "2026-07-25T10:00:01.000Z",
      type: "turn_context",
      payload: { approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } },
    },
    {
      timestamp: "2026-07-25T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "high" },
          { type: "future_block", mustSurvive: true },
        ],
      },
    },
    {
      timestamp: "2026-07-25T10:00:03.000Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "think" }], content: null },
    },
    {
      timestamp: "2026-07-25T10:00:04.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: '{"cmd":"dir"}', call_id: "call-1" },
    },
    {
      timestamp: "2026-07-25T10:00:05.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "done" },
    },
    {
      timestamp: "2026-07-25T10:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        message: "<task-notification><task-id>task-7</task-id><status>completed</status></task-notification>",
      },
    },
    {
      timestamp: "2026-07-25T10:00:07.000Z",
      type: "event_msg",
      payload: { type: "thread_goal_updated", goal: "ship safely", status: "active" },
    },
    { timestamp: "2026-07-25T10:00:08.000Z", type: "world_state", payload: { cwd: "C:\\repo", active: true } },
    { timestamp: "2026-07-25T10:00:09.000Z", type: "compacted", payload: { replacement_history: [] } },
    { timestamp: "2026-07-25T10:00:10.000Z", type: "future_record", payload: { mustSurvive: true } },
  ];
  const envelopes = records.map((record, recordIndex) => createEnvelope("codex", json(record), {
    sourcePath: "C:/rollout.jsonl",
    recordIndex,
    lineEnding: "\n",
  }));
  const malformed = createEnvelope("codex", "{broken", {
    sourcePath: "C:/rollout.jsonl",
    recordIndex: records.length,
    lineEnding: "\n",
  });
  const events = [...envelopes, malformed].flatMap(codexRecordToIr);
  const remapped = [...envelopes, malformed].flatMap(codexRecordToIr);

  assert.deepEqual(
    new Set(events.map((event) => event.sourceEnvelopeId)),
    new Set([...envelopes, malformed].map((envelope) => envelope.id)),
  );
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.deepEqual(remapped.map((event) => event.id), events.map((event) => event.id));
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "protocol",
      "turn_context",
      "access_snapshot",
      "text",
      "media",
      "unknown",
      "reasoning",
      "tool_use",
      "tool_result",
      "protocol",
      "task_notification",
      "protocol",
      "goal_snapshot",
      "world_state",
      "compact_boundary",
      "unknown",
      "unknown",
    ],
  );

  const task = events.find((event) => event.kind === "task_notification");
  assert.ok(task && task.kind === "task_notification");
  assert.equal(task.taskId, "task-7");
  assert.equal(task.safety.resumeTask, false);
  const goal = events.find((event) => event.kind === "goal_snapshot");
  assert.ok(goal && goal.kind === "goal_snapshot");
  assert.equal(goal.goal, "ship safely");
  assert.equal(goal.safety.activateGoal, false);
  const access = events.find((event) => event.kind === "access_snapshot");
  assert.ok(access && access.kind === "access_snapshot");
  assert.equal(access.permissionMode, "on-request");
  assert.equal(access.safety.applyAccess, false);
  const media = events.find((event) => event.kind === "media");
  assert.ok(media && media.kind === "media");
  assert.equal(media.mediaType, "image");
  assert.equal(media.source, "data:image/png;base64,AA==");
});

test("Codex injected user-role context is historical while a wrapped request stays human-authored", () => {
  const injected = {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context><cwd>C:\\repo</cwd></environment_context>" }],
    },
  };
  const wrapped = {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>follow this</INSTRUCTIONS>\n\n## My request for Codex:\n\nship it",
      }],
    },
  };
  const events = [injected, wrapped].flatMap((record, recordIndex) => codexRecordToIr(createEnvelope(
    "codex",
    json(record),
    { sourcePath: "C:/rollout.jsonl", recordIndex, lineEnding: "\n" },
  )));

  assert.deepEqual(events.map((event) => event.kind), ["text", "text", "text"]);
  const text = events.filter((event): event is Extract<typeof event, { kind: "text" }> => event.kind === "text");
  assert.deepEqual(text.map((event) => event.authoredByHuman), [false, false, true]);
  assert.deepEqual(text.map((event) => event.role), ["system", "system", "user"]);
  assert.equal(text[2]?.text, "ship it");
});

test("Codex event_msg mirrors stay protocol-only and future suffixes need tool structure", () => {
  const records = [
    { type: "event_msg", payload: { type: "user_message", message: "same message" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "same message" }] } },
    { type: "response_item", payload: { type: "future_output", id: "item-1", content: "not a tool" } },
    { type: "response_item", payload: { type: "future_call", id: "item-2", input: { q: 1 } } },
  ];
  const events = records.flatMap((record, recordIndex) => codexRecordToIr(createEnvelope(
    "codex",
    json(record),
    { sourcePath: "C:/rollout.jsonl", recordIndex, lineEnding: "\n" },
  )));

  assert.deepEqual(events.map((event) => event.kind), ["protocol", "text", "unknown", "unknown"]);
  assert.equal(events.filter((event) => event.kind === "text").length, 1);
});

test("Codex bundle event coverage is complete without changing exact source bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ir-coverage-"));
  const sourcePath = path.join(root, "rollout.jsonl");
  const contents = [
    json({ type: "session_meta", payload: { id: "coverage", cwd: "C:\\repo" } }),
    json({ type: "event_msg", payload: { type: "task_started" } }),
    json({ type: "world_state", payload: { state: "opaque" } }),
  ].join("\r\n") + "\r\n";
  fs.writeFileSync(sourcePath, contents, "utf8");
  const session = {
    sessionId: "coverage", rolloutPath: sourcePath, cwd: "C:\\repo", cwdOriginal: "C:\\repo",
    meta: {}, firstTsMs: null, lastTsMs: null, items: [], model: null, messageCount: 0,
    title: "coverage", source: "vscode", isChild: false, userMessageCount: 0,
  } satisfies CodexSession;
  const bundle = codexRolloutToBridgeBundle(session);

  assert.equal(bundle.conversation.events.length, 3);
  assert.deepEqual(
    new Set(bundle.conversation.events.map((event) => event.sourceEnvelopeId)),
    new Set(bundle.conversation.recordEnvelopeIds),
  );
  assert.equal(bundle.envelopes.map((envelope) => envelope.raw + envelope.lineEnding).join(""), contents);
});

test("Claude records map to lossless historical IR without activating controls", () => {
  const records = [
    {
      type: "user",
      sessionId: "session-1",
      timestamp: "2026-07-25T10:00:00.000Z",
      permissionMode: "default",
      origin: { kind: "human" },
      message: { role: "user", content: "hello" },
    },
    {
      type: "assistant",
      sessionId: "session-1",
      timestamp: "2026-07-25T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.txt" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: "session-1",
      timestamp: "2026-07-25T10:00:02.000Z",
      toolUseResult: { ok: true },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
      },
    },
    {
      type: "user",
      sessionId: "session-1",
      timestamp: "2026-07-25T10:00:03.000Z",
      origin: { kind: "task-notification" },
      message: { role: "user", content: "<task-notification><task-id>task-7</task-id></task-notification>" },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      sessionId: "session-1",
      timestamp: "2026-07-25T10:00:04.000Z",
      compactMetadata: { trigger: "auto" },
    },
    {
      type: "user",
      sessionId: "session-1",
      timestamp: "2026-07-25T10:00:05.000Z",
      message: { role: "user", content: "<local-command-stdout>Goal set: ship safely</local-command-stdout>" },
    },
    {
      type: "future-record",
      sessionId: "session-1",
      payload: { mustSurvive: true },
    },
  ];
  const raw = records.map(json).join("\n") + "\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-map-"));
  const file = path.join(dir, "session-1.jsonl");
  fs.writeFileSync(file, raw, "utf8");

  const bundle = claudeTranscriptToIr(readClaudeJsonl(file));
  assert.equal(bundle.conversation.id, "session-1");
  assert.equal(bundle.envelopes.length, records.length);
  assert.deepEqual(
    bundle.conversation.events.map((event) => event.kind),
    [
      "access_snapshot",
      "text",
      "text",
      "tool_use",
      "tool_result",
      "task_notification",
      "compact_boundary",
      "goal_snapshot",
      "unknown",
    ],
  );

  const tool = bundle.conversation.events.find((event) => event.kind === "tool_use");
  assert.ok(tool && tool.kind === "tool_use");
  assert.equal(tool.safety.execute, false);
  const task = bundle.conversation.events.find((event) => event.kind === "task_notification");
  assert.ok(task && task.kind === "task_notification");
  assert.equal(task.taskId, "task-7");
  assert.equal(task.safety.resumeTask, false);
  const goal = bundle.conversation.events.find((event) => event.kind === "goal_snapshot");
  assert.ok(goal && goal.kind === "goal_snapshot");
  assert.equal(goal.goal, "ship safely");
  assert.equal(goal.safety.activateGoal, false);
  const access = bundle.conversation.events.find((event) => event.kind === "access_snapshot");
  assert.ok(access && access.kind === "access_snapshot");
  assert.equal(access.permissionMode, "default");
  assert.equal(access.safety.applyAccess, false);
  const unknown = bundle.conversation.events.at(-1);
  assert.ok(unknown && unknown.kind === "unknown");
  assert.deepEqual(unknown.value, records.at(-1));
});

test("unknown content blocks remain explicit even inside known message records", () => {
  const record = {
    type: "assistant",
    sessionId: "s",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "known" },
        { type: "future_block", opaque: { x: 1 } },
      ],
    },
  };
  const envelope = createEnvelope("claude", json(record), {
    sourcePath: "C:/s.jsonl",
    recordIndex: 0,
    lineEnding: "\n",
  });
  const events = claudeRecordToIr(envelope);
  assert.deepEqual(events.map((event) => event.kind), ["text", "unknown"]);
  const unknown = events[1];
  assert.ok(unknown.kind === "unknown");
  assert.equal(unknown.path, "message.content[1]");
  assert.deepEqual(unknown.value, { type: "future_block", opaque: { x: 1 } });
});

test("explicit opaque goal snapshots are known but remain inactive", () => {
  const record = {
    type: "goal_snapshot",
    sessionId: "s",
    goal: { objective: "opaque future shape" },
    status: "active",
  };
  const envelope = createEnvelope("claude", json(record), {
    sourcePath: "C:/s.jsonl",
    recordIndex: 0,
    lineEnding: "\n",
  });
  const events = claudeRecordToIr(envelope);
  assert.equal(events.length, 1);
  const goal = events[0];
  assert.ok(goal.kind === "goal_snapshot");
  assert.equal(goal.goal, null);
  assert.equal(goal.status, "active");
  assert.equal(goal.safety.activateGoal, false);
  assert.deepEqual(goal.snapshot, record);
});

test("bridge store deduplicates raw objects and verifies them on read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-store-"));
  const file = path.join(dir, "source.jsonl");
  fs.writeFileSync(
    file,
    `${json({ type: "user", sessionId: "stored", message: { role: "user", content: "hello" } })}\n`,
    "utf8",
  );
  const bundle = claudeTranscriptToIr(readClaudeJsonl(file));
  const root = path.join(dir, "store");

  const first = writeBridgeConversation(root, bundle);
  const second = writeBridgeConversation(root, bundle);
  assert.equal(first.objectsWritten, 1);
  assert.equal(second.objectsWritten, 0);
  assert.equal(second.objectsReused, 1);
  assert.equal(first.operation.status, "completed");

  const restored = readBridgeConversation(root, "stored");
  assert.deepEqual(restored, bundle);

  fs.writeFileSync(objectPath(root, bundle.envelopes[0].contentSha256), "{}", "utf8");
  assert.throws(() => readBridgeConversation(root, "stored"), /object|hash|envelope/i);
});

test("bridge store detects a modified conversation manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-manifest-"));
  const file = path.join(dir, "source.jsonl");
  fs.writeFileSync(file, `${json({ type: "user", sessionId: "manifest", message: { content: "hello" } })}\n`);
  const bundle = claudeTranscriptToIr(readClaudeJsonl(file));
  const root = path.join(dir, "store");
  const result = writeBridgeConversation(root, bundle);
  const manifest = JSON.parse(fs.readFileSync(result.conversationPath, "utf8"));
  manifest.conversation.title = "tampered";
  fs.writeFileSync(result.conversationPath, JSON.stringify(manifest), "utf8");
  assert.throws(() => readBridgeConversation(root, "manifest"), /manifest hash mismatch/i);
});

test("bridge store keeps immutable revisions when an active session grows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-revisions-"));
  const file = path.join(dir, "source.jsonl");
  fs.writeFileSync(file, `${json({ type: "user", sessionId: "growing", message: { content: "one" } })}\n`);
  const root = path.join(dir, "store");
  const firstBundle = claudeTranscriptToIr(readClaudeJsonl(file));
  const first = writeBridgeConversation(root, firstBundle);
  const firstSha = first.operation.conversationSha256;

  fs.appendFileSync(file, `${json({ type: "assistant", sessionId: "growing", message: { content: "two" } })}\n`);
  const secondBundle = claudeTranscriptToIr(readClaudeJsonl(file));
  const second = writeBridgeConversation(root, secondBundle);
  assert.notEqual(first.conversationPath, second.conversationPath);
  assert.deepEqual(readBridgeConversation(root, "growing", firstSha), firstBundle);
  assert.deepEqual(readBridgeConversation(root, "growing"), secondBundle);
  const wrongRevision = "f".repeat(64);
  fs.copyFileSync(first.conversationPath, conversationRevisionPath(root, "growing", wrongRevision));
  assert.throws(() => readBridgeConversation(root, "growing", wrongRevision), /manifest hash mismatch/i);
});

test("bridge store hash-verifies and upgrades legacy IR v1 manifests on read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-v1-upgrade-"));
  const file = path.join(dir, "source.jsonl");
  fs.writeFileSync(file, `${json({ type: "user", sessionId: "legacy-v1", message: { content: "hello" } })}\n`);
  const root = path.join(dir, "store");
  const written = writeBridgeConversation(root, claudeTranscriptToIr(readClaudeJsonl(file)));
  const manifest = JSON.parse(fs.readFileSync(written.conversationPath, "utf8"));
  manifest.conversation.version = 1;
  manifest.contentSha256 = sha256Utf8(stableStringify({
    version: 1,
    conversation: manifest.conversation,
    envelopes: manifest.envelopes,
  }));
  const legacyPath = conversationRevisionPath(root, "legacy-v1", manifest.contentSha256);
  fs.writeFileSync(legacyPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(conversationPath(root, "legacy-v1"), `${JSON.stringify({
    version: 1,
    conversationId: "legacy-v1",
    contentSha256: manifest.contentSha256,
  }, null, 2)}\n`, "utf8");

  const restored = readBridgeConversation(root, "legacy-v1");
  assert.equal(restored.conversation.version, 2);
  assert.deepEqual(restored.conversation.events.map((event) => event.kind), ["text"]);
});

test("bridge store writes only the current IR version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-version-write-"));
  const file = path.join(dir, "source.jsonl");
  fs.writeFileSync(file, `${json({ type: "user", sessionId: "version-write", message: { content: "hello" } })}\n`);
  const bundle = claudeTranscriptToIr(readClaudeJsonl(file));
  for (const version of [1, 3]) {
    const unsupported = {
      ...bundle,
      conversation: { ...bundle.conversation, version },
    } as unknown as typeof bundle;
    assert.throws(
      () => writeBridgeConversation(path.join(dir, `store-v${version}`), unsupported),
      /unsupported bridge IR version/i,
    );
  }
});
