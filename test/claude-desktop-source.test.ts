import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inventoryClaudeDesktop, resolveClaudeDesktopWorkspace } from "../src/claude-desktop-source.ts";
import { transcriptPathFor } from "../src/claude-target.ts";

test("Claude Desktop inventory preserves archive state and exact wrapper identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-desktop-source-"));
  const claudeHome = path.join(root, "claude-home");
  const workspace = path.join(root, "sessions", "account", "device");
  fs.mkdirSync(workspace, { recursive: true });
  const record = {
    sessionId: "local_wrapper", cliSessionId: "cli-session", cwd: "C:\\repo",
    title: "Archived work", isArchived: true, createdAt: 10, lastActivityAt: 20,
  };
  fs.writeFileSync(path.join(workspace, "local_wrapper.json"), JSON.stringify(record));
  const transcript = transcriptPathFor(claudeHome, record.cwd, record.cliSessionId);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{}\n");

  const inventory = inventoryClaudeDesktop(claudeHome, workspace);
  assert.equal(inventory.sessions.length, 1);
  assert.equal(inventory.sessions[0].isArchived, true);
  assert.equal(inventory.sessions[0].wrapperSessionId, "local_wrapper");
  assert.equal(inventory.sessions[0].sessionId, "local_wrapper");
  assert.equal(inventory.sessions[0].cliSessionId, "cli-session");
  assert.equal(inventory.sessions[0].transcriptExists, true);
});

test("transcript-unavailable wrappers remain visible in archive inventory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-unavailable-"));
  const workspace = path.join(root, "sessions", "account", "device");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "local_unavailable.json"), JSON.stringify({
    sessionId: "local_unavailable", cwd: "C:\\repo", isArchived: true,
    transcriptUnavailable: true, completedTurns: 7,
  }));
  const inventory = inventoryClaudeDesktop(path.join(root, "claude"), workspace);
  assert.equal(inventory.sessions.length, 1);
  assert.equal(inventory.sessions[0].transcriptStatus, "unavailable");
  assert.equal(inventory.sessions[0].transcriptPath, null);
});

test("a missing wrapper archive field remains explicit unknown with provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-archive-unknown-"));
  const workspace = path.join(root, "sessions", "account", "device");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "local_unknown.json"), JSON.stringify({
    sessionId: "local_unknown", cwd: "C:\\repo", transcriptUnavailable: true,
  }));
  const inventory = inventoryClaudeDesktop(path.join(root, "claude"), workspace);
  assert.equal(inventory.sessions[0]?.isArchived, undefined);
  assert.equal(inventory.sessions[0]?.archiveState, "unknown");
  assert.equal(inventory.sessions[0]?.archiveProvenance, "claude-wrapper-missing-isArchived");
});

test("workspace resolution fails closed when several accounts are ambiguous", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-accounts-"));
  const sessionsRoot = path.join(root, "sessions");
  for (const account of ["a", "b"]) {
    const dir = path.join(sessionsRoot, account, "device");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `local_${account}.json`), JSON.stringify({ isArchived: false }));
  }
  assert.throws(
    () => resolveClaudeDesktopWorkspace(path.join(root, "missing-home"), sessionsRoot),
    /ambiguous/,
  );
});
