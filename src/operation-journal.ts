import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { threadRolloutPath, unregisterCodexThread41059 } from "./codex-target-db.ts";
import { stripWindowsExtendedPrefix } from "./project-identity.ts";

export type OperationState = "prepared" | "rollout-written" | "committed" | "recovered" | "failed";

export interface OperationAttemptSummary {
  attempt: number;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface OperationJournal {
  schema: "agentryx.bridge/operation-v1";
  operationId: string;
  attempt: number;
  previousAttempts: OperationAttemptSummary[];
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  sourceSha256: string;
  targetCodexHome: string;
  targetThreadId: string;
  targetRolloutPath: string;
  targetStagePath: string;
  targetRolloutSha256: string;
  targetDbPath: string;
  createdFiles: string[];
  error?: string;
}

export type OperationJournalInput = Omit<
  OperationJournal,
  "schema" | "state" | "createdAt" | "updatedAt" | "createdFiles" | "attempt" | "previousAttempts"
>;

function journalPath(root: string, operationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) {
    throw new Error(`invalid operation id: ${operationId}`);
  }
  return path.join(root, "operations", `${operationId}.json`);
}

function canonical(value: string): string {
  const resolved = path.resolve(stripWindowsExtendedPrefix(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(canonical(parent), canonical(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validateJournal(journal: OperationJournal, operationId: string): void {
  if (
    journal?.schema !== "agentryx.bridge/operation-v1" ||
    journal.operationId !== operationId ||
    !Number.isSafeInteger(journal.attempt) || journal.attempt < 1 ||
    !Array.isArray(journal.previousAttempts) ||
    !["prepared", "rollout-written", "committed", "recovered", "failed"].includes(journal.state) ||
    !/^[0-9a-f]{64}$/i.test(journal.sourceSha256) ||
    !/^[0-9a-f]{64}$/i.test(journal.targetRolloutSha256) ||
    typeof journal.targetCodexHome !== "string" ||
    typeof journal.targetDbPath !== "string" ||
    typeof journal.targetRolloutPath !== "string" ||
    typeof journal.targetStagePath !== "string" ||
    typeof journal.targetThreadId !== "string" ||
    !Array.isArray(journal.createdFiles)
  ) throw new Error(`invalid operation journal ${operationId}`);
  for (const attempt of journal.previousAttempts) {
    if (!Number.isSafeInteger(attempt?.attempt) || attempt.attempt < 1 ||
      !["prepared", "rollout-written", "committed", "recovered", "failed"].includes(attempt.state) ||
      typeof attempt.createdAt !== "string" || typeof attempt.updatedAt !== "string") {
      throw new Error(`invalid previous attempt in operation journal ${operationId}`);
    }
  }
  const home = canonical(journal.targetCodexHome);
  const rollout = canonical(journal.targetRolloutPath);
  const stage = canonical(journal.targetStagePath);
  const inSessions = within(path.join(home, "sessions"), rollout) ||
    within(path.join(home, "archived_sessions"), rollout);
  if (!inSessions) throw new Error("operation rollout path is outside Codex session roots");
  if (path.dirname(stage) !== path.dirname(rollout) ||
    path.basename(stage) !== `${path.basename(rollout)}.${journal.operationId}.stage`) {
    throw new Error("operation stage path is not tied to the target rollout");
  }
  if (canonical(path.dirname(journal.targetDbPath)) !== home || !/^state_\d+\.sqlite$/i.test(path.basename(journal.targetDbPath))) {
    throw new Error("operation database path is outside the pinned Codex home");
  }
  if (journal.createdFiles.some((file) => canonical(file) !== rollout)) {
    throw new Error("operation journal contains an unexpected created file");
  }
}

function atomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function atomicCreateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.create`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    // Linking is the no-overwrite publication step. A stale journal must be
    // recovered or explicitly removed; a new run never replaces its history.
    fs.linkSync(tmp, filePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function createOperationJournal(
  root: string,
  input: OperationJournalInput,
  now = new Date(),
): OperationJournal {
  const iso = now.toISOString();
  const target = journalPath(root, input.operationId);
  let attempt = 1;
  let previousAttempts: OperationAttemptSummary[] = [];
  if (fs.existsSync(target)) {
    const current = loadOperationJournal(root, input.operationId);
    if (current.state !== "failed" && current.state !== "recovered") {
      throw new Error(`operation journal is not retryable in state ${current.state}: ${input.operationId}`);
    }
    assertSameOperation(current, input);
    attempt = current.attempt + 1;
    previousAttempts = [...current.previousAttempts, {
      attempt: current.attempt,
      state: current.state,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      ...(current.error == null ? {} : { error: current.error }),
    }];
  }
  const journal: OperationJournal = {
    schema: "agentryx.bridge/operation-v1",
    attempt,
    previousAttempts,
    state: "prepared",
    createdAt: iso,
    updatedAt: iso,
    createdFiles: [],
    ...input,
  };
  if (attempt === 1) atomicCreateJson(target, journal);
  else atomicJson(target, journal);
  return journal;
}

export function loadOperationJournal(root: string, operationId: string): OperationJournal {
  const parsed = JSON.parse(fs.readFileSync(journalPath(root, operationId), "utf8")) as OperationJournal;
  // Prototype journals written before retry support are attempt 1.
  if (parsed.attempt == null) parsed.attempt = 1;
  if (parsed.previousAttempts == null) parsed.previousAttempts = [];
  validateJournal(parsed, operationId);
  return parsed;
}

function assertSameOperation(journal: OperationJournal, input: OperationJournalInput): void {
  const keys: Array<keyof OperationJournalInput> = [
    "operationId", "sourceSha256", "targetCodexHome", "targetThreadId", "targetRolloutPath",
    "targetStagePath", "targetRolloutSha256", "targetDbPath",
  ];
  for (const key of keys) {
    if (canonicalComparable(String(journal[key])) !== canonicalComparable(String(input[key]))) {
      throw new Error(`operation retry changed ${key}: ${input.operationId}`);
    }
  }
}

function canonicalComparable(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function assertOperationJournalReady(root: string, input: OperationJournalInput): void {
  const target = journalPath(root, input.operationId);
  if (!fs.existsSync(target)) {
    if (fs.existsSync(input.targetStagePath)) {
      throw new Error(`orphaned target stage requires inspection: ${input.targetStagePath}`);
    }
    return;
  }
  const current = loadOperationJournal(root, input.operationId);
  if (current.state !== "failed" && current.state !== "recovered") {
    throw new Error(`operation journal is not retryable in state ${current.state}: ${input.operationId}`);
  }
  assertSameOperation(current, input);
  if (fs.existsSync(input.targetStagePath)) {
    throw new Error(`operation retry requires recovery of its staged file: ${input.operationId}`);
  }
}

export function commitOperationJournalIfPresent(
  root: string,
  input: OperationJournalInput,
): OperationJournal | null {
  const target = journalPath(root, input.operationId);
  if (!fs.existsSync(target)) return null;
  const current = loadOperationJournal(root, input.operationId);
  assertSameOperation(current, input);
  if (current.state === "committed") return current;
  if (current.state !== "prepared" && current.state !== "rollout-written") {
    throw new Error(`an already-applied target has contradictory journal state ${current.state}`);
  }
  return updateOperationJournal(root, current, { state: "committed" });
}

export function updateOperationJournal(
  root: string,
  journal: OperationJournal,
  patch: Partial<Pick<OperationJournal, "state" | "createdFiles" | "error">>,
  now = new Date(),
): OperationJournal {
  const current = loadOperationJournal(root, journal.operationId);
  if (current.updatedAt !== journal.updatedAt || current.state !== journal.state) {
    throw new Error(`operation journal changed concurrently: ${journal.operationId}`);
  }
  if (journal.state === "committed" && patch.state && patch.state !== "committed") {
    throw new Error("a committed operation cannot be moved backwards");
  }
  const next = { ...journal, ...patch, updatedAt: now.toISOString() };
  atomicJson(journalPath(root, journal.operationId), next);
  return next;
}

export function recoverCreatedFiles(root: string, operationId: string): OperationJournal {
  let journal = loadOperationJournal(root, operationId);
  if (journal.state === "committed") throw new Error("committed operations require an explicit reverse migration");
  // Validate every deletable resource before changing either resource. If a
  // user or another process changed a file, recovery leaves the DB untouched.
  if (fs.existsSync(journal.targetRolloutPath) &&
    sha256File(journal.targetRolloutPath) !== journal.targetRolloutSha256.toLowerCase()) {
    throw new Error("target rollout changed after the operation; recovery refuses to delete it");
  }
  // A process can die after SQLite COMMIT but before the final journal update.
  // Reconcile the registration before deleting the rollout it points to.
  if (fs.existsSync(journal.targetDbPath)) {
    const registeredPath = threadRolloutPath(journal.targetDbPath, journal.targetThreadId);
    if (registeredPath != null) {
      if (canonical(registeredPath) !== canonical(journal.targetRolloutPath)) {
        throw new Error("registered Codex thread does not belong to this operation");
      }
      unregisterCodexThread41059(journal.targetDbPath, journal.targetThreadId);
      if (threadRolloutPath(journal.targetDbPath, journal.targetThreadId) != null) {
        throw new Error("failed to remove the Codex thread registration during recovery");
      }
    }
  }
  if (fs.existsSync(journal.targetRolloutPath)) {
    fs.rmSync(journal.targetRolloutPath, { force: true });
  }
  if (fs.existsSync(journal.targetStagePath)) {
    // A crash may interrupt writeFileSync and leave a partial stage. The exact
    // operation-scoped stage path is validated above and is never registered
    // in SQLite, so recovery removes it regardless of its partial hash.
    fs.rmSync(journal.targetStagePath, { force: true });
  }
  journal = updateOperationJournal(root, journal, { state: "recovered", createdFiles: [] });
  return journal;
}
