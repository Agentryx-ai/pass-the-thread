import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { CodexPrivateWriteCapability, CodexTargetEvidence } from "./version-gate.ts";
import { assertCodexPrivateWriteCapabilities } from "./version-gate.ts";
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
import type { CanonicalGoalSnapshot, GoalMigrationMode } from "./goal.ts";
import {
  assertCodexGoalReadback,
  CODEX_GOAL_TARGET_CAPABILITY_ID,
  CODEX_GOAL_TARGET_FINGERPRINT,
  codexGoalSetBinding,
  createCodexGoalRpc,
  planCodexGoalActivation,
  validateCodexGoalActivationPlan,
  type CodexGoalActivationPlan,
  type CodexGoalRpc,
} from "./codex-goal-target.ts";

export const CODEX_41059_PROVIDER_CONTEXT_WINDOW_TOKENS = 258_400;
/** Conservative offline refusal cap; this is serialized UTF-8 bytes, not provider tokens. */
export const CODEX_41059_SAFE_ACTIVE_UTF8_BYTES = 230_000;

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
  goalActivation: CodexGoalActivationPlan | null;
  requiredCapabilities: CodexPrivateWriteCapability[];
}

export interface ApplyCodexTargetOptions {
  allowWrite: boolean;
  evidence: CodexTargetEvidence;
  bridgeRoot: string;
  lock: CodexTargetLock;
  goalRpc?: CodexGoalRpc;
  desktopGuard?: () => void;
}

export interface CodexTargetLock {
  codexHome: string;
  lockPath: string;
  nonce: string;
  database: DatabaseSync;
}

export type CodexTargetPlanState = "absent" | "already-applied" | "collision";

interface CodexTargetThreadReadback {
  rolloutPath: string;
  archived: number;
  archivedAt: number | bigint | null;
}

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
  const registered = fs.existsSync(plan.dbPath) ? targetThreadReadback(plan.dbPath, plan.threadId) : null;
  if (!rolloutExists && registered == null) return "absent";
  if (rolloutExists && registered != null &&
    canonicalPath(registered.rolloutPath) === canonicalPath(plan.rolloutPath) &&
    archiveReadbackMatches(plan.archived, registered) &&
    createHash("sha256").update(fs.readFileSync(plan.rolloutPath)).digest("hex") === plan.rolloutSha256) {
    return "already-applied";
  }
  return "collision";
}

function targetThreadReadback(dbPath: string, threadId: string): CodexTargetThreadReadback | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT rollout_path, archived, archived_at FROM threads WHERE id = ?")
      .get(threadId) as { rollout_path?: unknown; archived?: unknown; archived_at?: unknown } | undefined;
    if (row == null) return null;
    if (typeof row.rollout_path !== "string" || typeof row.archived !== "number" ||
      ![0, 1].includes(row.archived) ||
      (row.archived_at !== null && typeof row.archived_at !== "number" && typeof row.archived_at !== "bigint")) {
      return { rolloutPath: "", archived: -1, archivedAt: null };
    }
    return { rolloutPath: row.rollout_path, archived: row.archived, archivedAt: row.archived_at };
  } finally {
    db.close();
  }
}

function archiveReadbackMatches(
  plannedArchived: boolean,
  readback: Pick<CodexTargetThreadReadback, "archived" | "archivedAt">,
): boolean {
  if (!plannedArchived) return readback.archived === 0 && readback.archivedAt === null;
  if (readback.archived !== 1 || readback.archivedAt == null) return false;
  const archivedAt = Number(readback.archivedAt);
  return Number.isSafeInteger(archivedAt) && archivedAt >= 0;
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
    goalActivation: plan.goalActivation,
  };
}

export function estimatedActiveBytes(conversation: Omit<LogicalCodexConversation, "threadId">): number {
  const items = conversation.items ?? conversation.messages;
  const configuredIndex = conversation.compaction?.activeItemIndex ??
    conversation.compaction?.activeMessageIndex;
  if (conversation.compaction != null && configuredIndex == null) {
    throw new Error("compacted history must identify its active-item boundary");
  }
  const activeIndex = configuredIndex ?? 0;
  if (!Number.isSafeInteger(activeIndex) || activeIndex < 0 || activeIndex > items.length) {
    throw new Error(`compaction active-item index ${activeIndex} is outside 0..${items.length}`);
  }
  for (const [name, value] of [
    ["source pre-compaction token counter", conversation.compaction?.preTokens],
    ["source post-compaction token counter", conversation.compaction?.postTokens],
  ] as const) {
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  const active = items.slice(activeIndex);
  const appendedBytes = Buffer.byteLength(JSON.stringify(active), "utf8");
  const replacementBytes = conversation.compaction?.summary == null
    ? 0
    : Buffer.byteLength(conversation.compaction.summary, "utf8");
  return replacementBytes + appendedBytes;
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
  goal: CanonicalGoalSnapshot | null = null,
  goalMode: GoalMigrationMode = "migrate",
): CodexTargetPlan {
  if (conversation.compaction != null &&
    (conversation.compaction.summary == null || conversation.compaction.summary.trim() === "")) {
    throw new Error("compacted Claude history has no replacement summary and cannot be resumed safely");
  }
  const activeBytes = estimatedActiveBytes(conversation);
  if (activeBytes > CODEX_41059_SAFE_ACTIVE_UTF8_BYTES) {
    throw new Error(
      `active imported context is ${activeBytes} UTF-8 bytes; conservative offline limit is ` +
      `${CODEX_41059_SAFE_ACTIVE_UTF8_BYTES} UTF-8 bytes (no provider token count is inferred)`,
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
  const goalActivation = planCodexGoalActivation(goal, goalMode, threadId);
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
    goalActivation,
    requiredCapabilities: [
      "rollout",
      "threadIndex",
      "projectIdentity",
      ...(archived ? ["archive" as const] : []),
    ],
  };
}

export function applyCodexTarget(plan: CodexTargetPlan, options: ApplyCodexTargetOptions): OperationJournal {
  if (!options.allowWrite) throw new Error("Codex target apply is disabled; create and inspect a plan first");
  assertTargetLock(options.lock, plan.codexHome);
  (options.desktopGuard ?? assertCodexDesktopClosed)();
  assertCodexPrivateWriteCapabilities(options.evidence, plan.requiredCapabilities);
  if (plan.goalActivation != null &&
    (plan.goalActivation.capabilityId !== CODEX_GOAL_TARGET_CAPABILITY_ID ||
      plan.goalActivation.profileFingerprint !== CODEX_GOAL_TARGET_FINGERPRINT)) {
    throw new Error("Codex Goal target capability changed after planning");
  }
  if (plan.goalActivation != null) validateCodexGoalActivationPlan(plan.goalActivation);
  const goalRpc = plan.goalActivation == null
    ? null
    : options.goalRpc ?? createCodexGoalRpc(options.evidence, plan.codexHome);
  const ownsGoalRpc = goalRpc != null && options.goalRpc == null;
  let applyError: unknown;
  try {
    // The exported API has the same before-first-write capability check as the
    // matrix CLI. Injected RPCs are probed too, so callers cannot accidentally
    // bypass the exact app-server profile preflight.
    goalRpc?.probe();
    return applyCodexTargetAfterGoalPreflight(plan, options, goalRpc);
  } catch (error) {
    applyError = error;
    throw error;
  } finally {
    if (ownsGoalRpc) {
      try { goalRpc.dispose(); }
      catch (cleanupError) {
        if (applyError != null) {
          throw new AggregateError([applyError, cleanupError], "Codex target apply and Goal RPC cleanup failed");
        }
        throw cleanupError;
      }
    }
  }
}

function applyCodexTargetAfterGoalPreflight(
  plan: CodexTargetPlan,
  options: ApplyCodexTargetOptions,
  goalRpc: CodexGoalRpc | null,
): OperationJournal {
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
    if (inspectCodexTargetPlan(plan) !== "already-applied") {
      throw new Error(`Codex target archive/path/hash readback differs after registration: ${plan.threadId}`);
    }
    journal = updateOperationJournal(options.bridgeRoot, journal, { state: "thread-registered" });
    if (plan.goalActivation != null) {
      if (goalRpc == null) throw new Error("Codex Goal RPC preflight was not established");
      const binding = codexGoalSetBinding(plan.operationId, plan.goalActivation);
      const preexisting = goalRpc.get(plan.threadId, binding);
      if (preexisting != null) {
        try {
          assertCodexGoalReadback(preexisting, plan.goalActivation.expectedReadback);
        } catch {
          journal = updateOperationJournal(options.bridgeRoot, journal, {
            state: "reconciliation-required",
            error: "Codex target thread has a differing Goal; importer preserved the thread and did not clear it",
          });
          throw new Error("Codex target Goal collision; importer will not overwrite or clear it");
        }
        if (hashText(fs.readFileSync(plan.rolloutPath, "utf8")) !== plan.rolloutSha256) {
          throw new Error("Codex Goal idempotency check found a changed imported rollout");
        }
        journal = updateOperationJournal(options.bridgeRoot, journal, {
          state: "goal-verified", observedGoal: preexisting,
        });
      } else {
        journal = updateOperationJournal(options.bridgeRoot, journal, { state: "goal-activation-requested" });
        const setGoal = goalRpc.set(plan.goalActivation.request, binding);
        assertCodexGoalReadback(setGoal, plan.goalActivation.expectedReadback);
        journal = updateOperationJournal(options.bridgeRoot, journal, {
          state: "goal-activation-confirmed", observedGoal: setGoal,
        });
        const readback = goalRpc.get(plan.threadId, binding);
        assertCodexGoalReadback(readback, plan.goalActivation.expectedReadback);
        if (!(["threadId", "objective", "status", "tokenBudget", "tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt"] as const)
          .every((field) => readback[field] === setGoal[field])) {
          throw new Error("Codex Goal changed between set response and restart readback");
        }
        if (hashText(fs.readFileSync(plan.rolloutPath, "utf8")) !== plan.rolloutSha256) {
          throw new Error("Codex Goal RPC changed the imported rollout");
        }
        journal = updateOperationJournal(options.bridgeRoot, journal, {
          state: "goal-verified", observedGoal: readback,
        });
      }
    }
    journal = updateOperationJournal(options.bridgeRoot, journal, { state: "committed" });
    return journal;
  } catch (error) {
    if (plan.goalActivation != null && new Set([
      "goal-activation-requested", "goal-activation-confirmed", "goal-verified", "reconciliation-required",
    ]).has(journal.state)) {
      let journalError: unknown;
      try {
        if (journal.state !== "reconciliation-required") {
          updateOperationJournal(options.bridgeRoot, journal, {
            state: "reconciliation-required",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (failure) { journalError = failure; }
      if (journalError != null) {
        throw new AggregateError([error, journalError], "Goal activation failed and reconciliation journaling failed");
      }
      throw new Error(
        `Codex Goal activation outcome requires reconciliation; importer artifacts were preserved: ${
          error instanceof Error ? error.message : String(error)}`,
      );
    }
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
