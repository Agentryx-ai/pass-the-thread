import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { CodexTargetEvidence } from "./version-gate.ts";
import { assertSupportedCodexTarget } from "./version-gate.ts";
import {
  buildCodexRollout41059,
  serializeCodexRollout41059,
  type LogicalCodexConversation,
} from "./compat/codex/v26_721_41059.ts";
import { registerCodexThread41059, threadRolloutPath, unregisterCodexThread41059 } from "./codex-target-db.ts";
import {
  createOperationJournal,
  updateOperationJournal,
  type OperationJournal,
  type OperationJournalInput,
} from "./operation-journal.ts";
import { stripWindowsExtendedPrefix } from "./project-identity.ts";

export const CODEX_41059_CONTEXT_WINDOW = 258_400;
export const CODEX_41059_SAFE_ACTIVE_TOKENS = 230_000;

export interface CodexTargetPlan {
  operationId: string;
  codexHome: string;
  sourceSha256: string;
  threadId: string;
  rolloutPath: string;
  stagePath: string;
  dbPath: string;
  archived: boolean;
  serializedRollout: string;
  rolloutSha256: string;
  conversation: LogicalCodexConversation;
}

export interface ApplyCodexTargetOptions {
  allowWrite: boolean;
  evidence: CodexTargetEvidence;
  bridgeRoot: string;
  lock: CodexTargetLock;
}

export interface CodexTargetLock {
  codexHome: string;
  lockPath: string;
  nonce: string;
  database: DatabaseSync;
}

export type CodexTargetPlanState = "absent" | "already-applied" | "collision";

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(stripWindowsExtendedPrefix(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function assertCodexDesktopClosed(): void {
  if (process.platform !== "win32") throw new Error("the 26.721.41059 target adapter is Windows-only");
  const output = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq Codex.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
  });
  if (/"Codex\.exe"/i.test(output)) throw new Error("Codex Desktop is running; close it before apply");
}

export function acquireCodexTargetLock(codexHome: string): CodexTargetLock {
  const resolvedHome = path.resolve(codexHome);
  fs.mkdirSync(resolvedHome, { recursive: true });
  const lockPath = path.join(resolvedHome, ".agentryx-session-import-lock.sqlite");
  const nonce = createHash("sha256")
    .update(`${process.pid}\0${Date.now()}\0${Math.random()}`, "utf8")
    .digest("hex");
  const database = new DatabaseSync(lockPath);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec(`
      CREATE TABLE IF NOT EXISTS lock_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        pid INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    // SQLite's OS-backed exclusive transaction is released automatically if
    // the importer crashes. It provides a single owner without stale marker
    // reclamation or a delete/create race.
    database.exec("BEGIN EXCLUSIVE");
    database.prepare(`
      INSERT INTO lock_owner(singleton, pid, nonce, created_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        pid = excluded.pid,
        nonce = excluded.nonce,
        created_at = excluded.created_at
    `).run(process.pid, nonce, new Date().toISOString());
  } catch (error) {
    database.close();
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(error instanceof Error ? error.message : String(error))) {
      throw new Error(`another import owns the Codex target lock: ${lockPath}`);
    }
    throw error;
  }
  return { codexHome: resolvedHome, lockPath, nonce, database };
}

function assertTargetLock(lock: CodexTargetLock, codexHome: string): void {
  if (canonicalPath(lock.codexHome) !== canonicalPath(codexHome)) {
    throw new Error("Codex target lock belongs to a different home");
  }
  const current = lock.database.prepare("SELECT nonce FROM lock_owner WHERE singleton = 1").get() as { nonce?: unknown } | undefined;
  if (current?.nonce !== lock.nonce) throw new Error("Codex target lock ownership changed");
}

export function releaseCodexTargetLock(lock: CodexTargetLock): void {
  const errors: unknown[] = [];
  try { assertTargetLock(lock, lock.codexHome); } catch (error) { errors.push(error); }
  // The owner row is diagnostic transaction-local state. Rolling it back avoids
  // turning lock release into a durable write with an extra commit failure mode.
  try { lock.database.exec("ROLLBACK"); } catch (error) { errors.push(error); }
  try { lock.database.close(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Codex target lock cleanup failed");
}

export function inspectCodexTargetPlan(plan: CodexTargetPlan): CodexTargetPlanState {
  const rolloutExists = fs.existsSync(plan.rolloutPath);
  const registeredPath = fs.existsSync(plan.dbPath) ? threadRolloutPath(plan.dbPath, plan.threadId) : null;
  if (!rolloutExists && registeredPath == null) return "absent";
  if (rolloutExists && registeredPath != null &&
    canonicalPath(registeredPath) === canonicalPath(plan.rolloutPath) &&
    createHash("sha256").update(fs.readFileSync(plan.rolloutPath)).digest("hex") === plan.rolloutSha256) {
    return "already-applied";
  }
  return "collision";
}

export function operationJournalInputForPlan(plan: CodexTargetPlan): OperationJournalInput {
  return {
    operationId: plan.operationId,
    sourceSha256: plan.sourceSha256,
    targetCodexHome: plan.codexHome,
    targetThreadId: plan.threadId,
    targetRolloutPath: plan.rolloutPath,
    targetStagePath: plan.stagePath,
    targetRolloutSha256: plan.rolloutSha256,
    targetDbPath: plan.dbPath,
  };
}

export function estimatedActiveTokens(conversation: Omit<LogicalCodexConversation, "threadId">): number {
  const explicit = conversation.compaction?.postTokens;
  const items = conversation.items ?? conversation.messages;
  const activeIndex = conversation.compaction?.activeItemIndex ??
    conversation.compaction?.activeMessageIndex ?? 0;
  const active = items.slice(activeIndex);
  // A conservative offline estimate used only as a refusal threshold. Exact
  // tokenisation is model-specific; callers see this estimate in the plan.
  // The pinned tokenizer is not available locally. Every token consumes at
  // least one UTF-8 byte, so byte length is a deliberately conservative upper
  // bound for CJK, emoji, ASCII, and high-entropy content.
  const appendedEstimate = Buffer.byteLength(JSON.stringify(active), "utf8");
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) {
    return explicit + appendedEstimate;
  }
  return appendedEstimate;
}

export function deterministicThreadId(sourceId: string, sourceSha256: string): string {
  const hex = createHash("sha256").update(`${sourceId}\0${sourceSha256}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function planCodexTarget(
  codexHome: string,
  dbPath: string,
  sourceId: string,
  sourceSha256: string,
  conversation: Omit<LogicalCodexConversation, "threadId">,
  archived = false,
): CodexTargetPlan {
  const activeTokens = estimatedActiveTokens(conversation);
  if (activeTokens > CODEX_41059_SAFE_ACTIVE_TOKENS) {
    throw new Error(
      `active imported context is about ${activeTokens} tokens; safe limit is ${CODEX_41059_SAFE_ACTIVE_TOKENS}`,
    );
  }
  const threadId = deterministicThreadId(sourceId, sourceSha256);
  const fullConversation = { ...conversation, threadId };
  const serializedRollout = serializeCodexRollout41059(buildCodexRollout41059(fullConversation));
  const created = new Date(conversation.createdAt);
  if (Number.isNaN(created.getTime())) throw new Error("conversation.createdAt must be ISO-8601");
  const dir = archived ? "archived_sessions" : path.join("sessions", created.getUTCFullYear().toString(), String(created.getUTCMonth() + 1).padStart(2, "0"), String(created.getUTCDate()).padStart(2, "0"));
  const stamp = conversation.createdAt.replace(/[:.]/g, "-").replace(/Z$/, "");
  const rolloutPath = path.join(codexHome, dir, `rollout-${stamp}-${threadId}.jsonl`);
  const operationId = hashText(`operation\0${sourceSha256}\0${threadId}`).slice(0, 32);
  return {
    operationId,
    codexHome: path.resolve(codexHome),
    sourceSha256,
    threadId,
    rolloutPath,
    stagePath: `${rolloutPath}.${operationId}.stage`,
    dbPath,
    archived,
    serializedRollout,
    rolloutSha256: hashText(serializedRollout),
    conversation: fullConversation,
  };
}

export function applyCodexTarget(plan: CodexTargetPlan, options: ApplyCodexTargetOptions): OperationJournal {
  if (!options.allowWrite) throw new Error("Codex target apply is disabled; create and inspect a plan first");
  assertTargetLock(options.lock, plan.codexHome);
  assertCodexDesktopClosed();
  assertSupportedCodexTarget(options.evidence);
  const targetState = inspectCodexTargetPlan(plan);
  if (targetState !== "absent") throw new Error(`target is not absent (${targetState}): ${plan.threadId}`);

  let journal = createOperationJournal(options.bridgeRoot, operationJournalInputForPlan(plan));
  try {
    fs.mkdirSync(path.dirname(plan.rolloutPath), { recursive: true });
    fs.writeFileSync(plan.stagePath, plan.serializedRollout, { encoding: "utf8", flag: "wx" });
    fs.renameSync(plan.stagePath, plan.rolloutPath);
    journal = updateOperationJournal(options.bridgeRoot, journal, {
      state: "rollout-written",
      createdFiles: [plan.rolloutPath],
    });
    const firstUser = plan.conversation.messages.find((message) => message.role === "user")?.text ?? "";
    const createdAtMs = Date.parse(plan.conversation.createdAt);
    let updatedAtMs = createdAtMs;
    for (const message of plan.conversation.messages) {
      if (!message.timestamp) continue;
      const parsed = Date.parse(message.timestamp);
      if (Number.isFinite(parsed) && parsed > updatedAtMs) updatedAtMs = parsed;
    }
    registerCodexThread41059(plan.dbPath, {
      id: plan.threadId,
      rolloutPath: plan.rolloutPath,
      cwd: plan.conversation.cwd,
      title: plan.conversation.title || firstUser.slice(0, 200),
      createdAtMs,
      updatedAtMs,
      archived: plan.archived,
      firstUserMessage: firstUser,
      preview: firstUser.slice(0, 500),
    });
    journal = updateOperationJournal(options.bridgeRoot, journal, { state: "committed" });
    return journal;
  } catch (error) {
    let cleanupError: unknown;
    try {
      const registeredPath = fs.existsSync(plan.dbPath) ? threadRolloutPath(plan.dbPath, plan.threadId) : null;
      if (registeredPath != null) {
        if (path.resolve(stripWindowsExtendedPrefix(registeredPath)).toLowerCase() !==
          path.resolve(stripWindowsExtendedPrefix(plan.rolloutPath)).toLowerCase()) {
          throw new Error("registered thread path does not match the failed operation");
        }
        unregisterCodexThread41059(plan.dbPath, plan.threadId);
      }
    } catch (cleanup) {
      cleanupError = cleanup;
    }
    if (cleanupError == null) {
      if (fs.existsSync(plan.rolloutPath) && hashText(fs.readFileSync(plan.rolloutPath, "utf8")) === plan.rolloutSha256) {
        fs.rmSync(plan.rolloutPath, { force: true });
      }
      if (fs.existsSync(plan.stagePath) && hashText(fs.readFileSync(plan.stagePath, "utf8")) === plan.rolloutSha256) {
        fs.rmSync(plan.stagePath, { force: true });
      }
    }
    updateOperationJournal(options.bridgeRoot, journal, {
      state: "failed",
      createdFiles: fs.existsSync(plan.rolloutPath) ? [plan.rolloutPath] : [],
      error: [error, cleanupError].filter(Boolean).map((item) => item instanceof Error ? item.message : String(item)).join("; "),
    });
    if (cleanupError != null) throw new AggregateError([error, cleanupError], "target apply and cleanup both failed");
    throw error;
  }
}
