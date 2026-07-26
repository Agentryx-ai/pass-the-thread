import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEnvelope } from "../src/envelope.ts";
import { readClaudeJsonl, scanClaudeSessions } from "../src/claude-source.ts";
import { claudeRecordToIr, claudeTranscriptToIr } from "../src/claude-to-ir.ts";
import { codexRolloutToBridgeBundle } from "../src/codex-to-ir.ts";
import type { CodexSession } from "../src/types.ts";
import {
  objectPath,
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
