import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { stableStringify } from "./envelope.ts";
import type { CanonicalGoalSnapshot, GoalMigrationMode } from "./goal.ts";
import { validateCanonicalGoalSnapshot } from "./goal.ts";
import { stripWindowsExtendedPrefix } from "./project-identity.ts";
import { assertSupportedCodexTarget, type CodexTargetEvidence } from "./version-gate.ts";

export const CODEX_GOAL_TARGET_CAPABILITY_ID = "codex.goal-app-server/v1" as const;
export const CODEX_GOAL_CLEAR_ROLLBACK_SUPPORTED = false as const;

const PROFILE = {
  capabilityId: CODEX_GOAL_TARGET_CAPABILITY_ID,
  feature: "goals",
  transport: "stdio",
  initializeExperimentalApi: true,
  methods: ["thread/goal/get", "thread/goal/set"],
  setFields: ["threadId", "objective", "status", "tokenBudget"],
  readbackFields: ["threadId", "objective", "status", "tokenBudget"],
  clearRollback: "unsupported-unconditional-no-precondition",
} as const;

export const CODEX_GOAL_TARGET_FINGERPRINT = createHash("sha256")
  .update(stableStringify(PROFILE), "utf8").digest("hex");

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexGoalExpectedReadback {
  threadId: string;
  objective: string;
  status: "active";
  tokenBudget: number | null;
}

export interface CodexGoalActivationPlan {
  capabilityId: typeof CODEX_GOAL_TARGET_CAPABILITY_ID;
  profileFingerprint: string;
  sourceGoalSha256: string;
  targetThreadId: string;
  targetGoalId: null;
  request: CodexGoalExpectedReadback;
  expectedReadback: CodexGoalExpectedReadback;
  sourceCountersMigrated: false;
}

export interface CodexGoalRpc {
  probe(): void;
  get(threadId: string, binding: CodexGoalSetBinding): CodexThreadGoal | null;
  set(request: CodexGoalExpectedReadback, binding: CodexGoalSetBinding): CodexThreadGoal;
  dispose(): void;
}

export interface CodexGoalSetBinding {
  operationId: string;
  targetThreadId: string;
  capabilityId: typeof CODEX_GOAL_TARGET_CAPABILITY_ID;
  profileFingerprint: string;
}

function canonical(value: string): string {
  const candidate = path.resolve(stripWindowsExtendedPrefix(value));
  let resolved = candidate;
  try { resolved = fs.realpathSync.native(candidate); } catch { /* validated by caller */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid Codex Goal ${field}`);
  }
}

export function validateCodexThreadGoal(value: unknown): asserts value is CodexThreadGoal {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Codex Goal RPC response");
  }
  const goal = value as Partial<CodexThreadGoal>;
  if (typeof goal.threadId !== "string" || goal.threadId === "" ||
    typeof goal.objective !== "string" || goal.objective.trim() === "" ||
    !new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]).has(String(goal.status)) ||
    (goal.tokenBudget !== null && (typeof goal.tokenBudget !== "number" || !Number.isSafeInteger(goal.tokenBudget) || goal.tokenBudget < 0))) {
    throw new Error("invalid Codex Goal RPC response fields");
  }
  assertNonNegativeInteger(goal.tokensUsed, "tokensUsed");
  assertNonNegativeInteger(goal.timeUsedSeconds, "timeUsedSeconds");
  assertNonNegativeInteger(goal.createdAt, "createdAt");
  assertNonNegativeInteger(goal.updatedAt, "updatedAt");
}

export function planCodexGoalActivation(
  goal: CanonicalGoalSnapshot | null | undefined,
  mode: GoalMigrationMode,
  targetThreadId: string,
): CodexGoalActivationPlan | null {
  if (goal == null || mode === "skip" || !goal.migrationEligible) return null;
  validateCanonicalGoalSnapshot(goal);
  if (goal.status !== "active") throw new Error("only an active canonical Goal can be activated in Codex");
  if (!targetThreadId) throw new Error("Codex Goal target thread id is required");
  // Provider counters are not portable accounting units. Only a native Codex
  // token budget is semantically identical; all consumed counters restart.
  const tokenBudget = goal.provider === "codex" ? goal.tokenBudget : null;
  const expectedReadback: CodexGoalExpectedReadback = {
    threadId: targetThreadId,
    objective: goal.objective,
    status: "active",
    tokenBudget,
  };
  return {
    capabilityId: CODEX_GOAL_TARGET_CAPABILITY_ID,
    profileFingerprint: CODEX_GOAL_TARGET_FINGERPRINT,
    sourceGoalSha256: goal.sourceSha256,
    targetThreadId,
    targetGoalId: null,
    request: { ...expectedReadback },
    expectedReadback,
    sourceCountersMigrated: false,
  };
}

export function assertCodexGoalReadback(
  actual: CodexThreadGoal | null,
  expected: CodexGoalExpectedReadback,
): asserts actual is CodexThreadGoal {
  if (actual == null) throw new Error("Codex Goal readback is absent");
  validateCodexThreadGoal(actual);
  if (actual.threadId !== expected.threadId || actual.objective !== expected.objective ||
    actual.status !== expected.status || actual.tokenBudget !== expected.tokenBudget) {
    throw new Error("Codex Goal readback does not match the confirmed activation plan");
  }
}

export function validateCodexGoalActivationPlan(value: unknown): asserts value is CodexGoalActivationPlan {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Codex Goal activation plan");
  }
  const plan = value as Partial<CodexGoalActivationPlan>;
  if (plan.capabilityId !== CODEX_GOAL_TARGET_CAPABILITY_ID ||
    plan.profileFingerprint !== CODEX_GOAL_TARGET_FINGERPRINT ||
    typeof plan.sourceGoalSha256 !== "string" || !/^[0-9a-f]{64}$/.test(plan.sourceGoalSha256) ||
    typeof plan.targetThreadId !== "string" || plan.targetThreadId === "" ||
    plan.targetGoalId !== null || plan.sourceCountersMigrated !== false ||
    plan.request == null || plan.expectedReadback == null) {
    throw new Error("invalid Codex Goal activation binding");
  }
  const expected = plan.expectedReadback;
  if (expected.threadId !== plan.targetThreadId || expected.status !== "active" ||
    typeof expected.objective !== "string" || expected.objective.trim() === "" ||
    (expected.tokenBudget !== null &&
      (typeof expected.tokenBudget !== "number" || !Number.isSafeInteger(expected.tokenBudget) || expected.tokenBudget < 0)) ||
    plan.request.threadId !== expected.threadId || plan.request.objective !== expected.objective ||
    plan.request.status !== expected.status || plan.request.tokenBudget !== expected.tokenBudget) {
    throw new Error("invalid Codex Goal activation request/readback contract");
  }
}

export function codexGoalSetBinding(
  operationId: string,
  activation: CodexGoalActivationPlan,
): CodexGoalSetBinding {
  const binding: CodexGoalSetBinding = {
    operationId,
    targetThreadId: activation.targetThreadId,
    capabilityId: activation.capabilityId,
    profileFingerprint: activation.profileFingerprint,
  };
  validateGoalSetBinding(binding, activation.targetThreadId);
  return binding;
}

const RPC_WORKER = String.raw`
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const [exe, codexHome, method, initialParamsText, fencePath, setNonce, controlText] = process.argv.slice(1);
let paramsText = initialParamsText;
const control = controlText ? JSON.parse(controlText) : {};
let fence;
try {
  fence = new DatabaseSync(fencePath);
  fence.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS rpc_fence (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)); BEGIN EXCLUSIVE");
  const binding = fence.prepare("SELECT codex_home FROM target_binding WHERE singleton = 1").get();
  const normalize = value => {
    let resolved = require("node:path").resolve(value);
    try { resolved = require("node:fs").realpathSync.native(resolved); } catch {}
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (!binding || typeof binding.codex_home !== "string" || normalize(binding.codex_home) !== normalize(codexHome)) {
    throw new Error("Codex Goal RPC fence belongs to a different Codex home");
  }
  if (method === "thread/goal/set") {
    const params = JSON.parse(paramsText);
    const reservation = fence.prepare("SELECT nonce, state FROM set_invocations_v2 " +
      "WHERE thread_id = ? AND operation_id = ? AND capability_id = ? AND profile_fingerprint = ?")
      .get(params.threadId, params.__operationId, params.__capabilityId, params.__profileFingerprint);
    if (!reservation || reservation.nonce !== setNonce || reservation.state !== "pending") {
      throw new Error("Codex Goal set reservation was cancelled or replaced");
    }
    const claimed = fence.prepare("UPDATE set_invocations_v2 SET state = 'claimed' " +
      "WHERE thread_id = ? AND operation_id = ? AND capability_id = ? AND profile_fingerprint = ? " +
      "AND nonce = ? AND state = 'pending'")
      .run(params.threadId, params.__operationId, params.__capabilityId, params.__profileFingerprint, setNonce);
    if (claimed.changes !== 1) throw new Error("Codex Goal set reservation claim failed");
    // Persist the claimed tombstone before app-server can start. If this worker
    // is hard-terminated and its child survives, recovery sees claimed and
    // fails closed instead of treating the rolled-back row as cancellable.
    fence.exec("COMMIT");
    fence.exec("BEGIN EXCLUSIVE");
    const durableClaim = fence.prepare("SELECT state FROM set_invocations_v2 " +
      "WHERE thread_id = ? AND operation_id = ? AND capability_id = ? AND profile_fingerprint = ? AND nonce = ?")
      .get(params.threadId, params.__operationId, params.__capabilityId, params.__profileFingerprint, setNonce);
    if (!durableClaim || durableClaim.state !== "claimed") {
      throw new Error("Codex Goal durable set claim failed revalidation");
    }
    delete params.__operationId; delete params.__capabilityId; delete params.__profileFingerprint;
    paramsText = JSON.stringify(params);
  }
} catch (error) {
  try { fence?.close(); } catch {}
  process.stderr.write("Codex Goal RPC recovery fence is owned by another process: " + error.message);
  process.exit(1);
}
const child = spawn(exe, ["app-server", "--stdio", "--enable", "goals"], {
  env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = ""; let stderr = ""; let done = false;
let resultValue = null; let resultError = null;
const release = () => {
  try {
    if (method === "thread/goal/set") {
      const params = JSON.parse(paramsText);
      const completed = fence.prepare("UPDATE set_invocations_v2 SET state = 'completed' " +
        "WHERE thread_id = ? AND nonce = ? AND state = 'claimed'").run(params.threadId, setNonce);
      if (completed.changes !== 1) throw new Error("Codex Goal set reservation completion failed");
      fence.exec("COMMIT");
    } else fence.exec("ROLLBACK");
  } catch {} try { fence.close(); } catch {}
  if (resultError) { process.stderr.write(resultError + (stderr ? "\n" + stderr : "")); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify(resultValue));
};
const finish = (value, error) => {
  if (done) return; done = true; clearTimeout(timer);
  resultValue = value; resultError = error;
  try { child.stdin.end(); } catch {} try { child.kill(); } catch {}
  if (child.exitCode != null) release(); else child.once("close", release);
};
const timer = setTimeout(() => finish(null, "Codex app-server Goal RPC timed out"), 15000);
child.on("error", e => finish(null, e.message));
process.on("exit", () => { try { child.kill(); } catch {} });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => finish(null, "Codex Goal RPC worker was interrupted"));
}
child.stderr.on("data", b => { stderr += b.toString("utf8"); });
child.stdout.on("data", b => {
  stdout += b.toString("utf8");
  for (;;) {
    const i = stdout.indexOf("\n"); if (i < 0) break;
    const line = stdout.slice(0, i).trim(); stdout = stdout.slice(i + 1); if (!line) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) {
      if (message.error) return finish(null, JSON.stringify(message.error));
      if (!message.result || typeof message.result !== "object" || Array.isArray(message.result) ||
        !Object.prototype.hasOwnProperty.call(message.result, "codexHome") ||
        typeof message.result.codexHome !== "string") {
        return finish(null, "Codex app-server returned an invalid initialize result");
      }
      initResult = message.result;
      child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      if (method === "probe") return finish({ initialize: message.result, result: null }, null);
      child.stdin.write(JSON.stringify({ method, id: 2, params: JSON.parse(paramsText) }) + "\n");
      if (method === "thread/goal/set" && typeof control.afterSetSentPath === "string") {
        require("node:fs").writeFileSync(control.afterSetSentPath,
          JSON.stringify({ workerPid: process.pid, childPid: child.pid, executable: exe }), { flag: "wx" });
      }
    } else if (message.id === 2) {
      if (message.error) return finish(null, JSON.stringify(message.error));
      if (method === "thread/goal/set" && Number.isSafeInteger(control.holdAfterSetSentMs) && control.holdAfterSetSentMs > 0) {
        return setTimeout(() => finish({ initialize: initResult, result: message.result }, null), control.holdAfterSetSentMs);
      }
      return finish({ initialize: initResult, result: message.result }, null);
    }
  }
});
let initResult = null;
child.stdin.write(JSON.stringify({ method: "initialize", id: 1, params: {
  clientInfo: { name: "pass-the-thread", title: "Pass the Thread", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
} }) + "\n");
`;

interface RpcWorkerResult { initialize: { codexHome: string }; result: unknown }

interface RpcWorkerControl {
  afterSetSentPath: string;
  holdAfterSetSentMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseRpcWorkerResult(output: string): RpcWorkerResult {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !isRecord(parsed.initialize) ||
    !Object.prototype.hasOwnProperty.call(parsed.initialize, "codexHome") ||
    typeof parsed.initialize.codexHome !== "string" ||
    !Object.prototype.hasOwnProperty.call(parsed, "result")) {
    throw new Error("invalid Codex app-server RPC envelope");
  }
  return { initialize: { codexHome: parsed.initialize.codexHome }, result: parsed.result };
}

export function parseCodexGoalGetResult(value: unknown): CodexThreadGoal | null {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "goal")) {
    throw new Error("invalid Codex Goal get response envelope");
  }
  if (value.goal === null) return null;
  validateCodexThreadGoal(value.goal);
  return value.goal;
}

function parseCodexGoalSetResult(value: unknown): CodexThreadGoal {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "goal")) {
    throw new Error("invalid Codex Goal set response envelope");
  }
  validateCodexThreadGoal(value.goal);
  return value.goal;
}

function runRpc(
  exe: string,
  evidence: CodexTargetEvidence,
  codexHome: string,
  fencePath: string,
  method: string,
  params: unknown,
  setNonce = "",
  control?: RpcWorkerControl,
): RpcWorkerResult {
  if (sha256File(exe).toLowerCase() !== evidence.codexExeSha256.toLowerCase()) {
    throw new Error("Codex Goal runtime executable changed during activation");
  }
  const output = execFileSync(process.execPath, ["--experimental-sqlite", "-e", RPC_WORKER,
    exe, path.resolve(codexHome), method, JSON.stringify(params), fencePath, setNonce,
    control == null ? "" : JSON.stringify(control)], {
    encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
  const parsed = parseRpcWorkerResult(output);
  if (canonical(parsed.initialize.codexHome) !== canonical(codexHome)) {
    throw new Error("Codex app-server initialized against a different CODEX_HOME");
  }
  return parsed;
}

interface RuntimeLease { executable: string; verify(): void; dispose(): void }

function assertNoReparsePath(value: string): void {
  const parsed = path.parse(value);
  let current = parsed.root;
  for (const segment of value.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Codex Goal runtime path traverses a symlink or reparse point: ${current}`);
    }
  }
}

interface WindowsAclEvidence {
  owner: string;
  currentUser: string;
  protected: boolean;
  rules: Array<{ identity: string; type: string; rights: number }>;
}

const PRIVATE_DIRECTORY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:PTT_ACL_TARGET)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $sid,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule) | Out-Null
[IO.Directory]::SetAccessControl($target, $acl)
$verified = [IO.Directory]::GetAccessControl($target, [Security.AccessControl.AccessControlSections]'Access, Owner')
$rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [pscustomobject]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = [int64]$_.FileSystemRights }
})
[pscustomobject]@{
  owner = $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value
  currentUser = $sid.Value
  protected = $verified.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;

const INSPECT_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:PTT_ACL_TARGET)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $target -Force
$verified = $item.GetAccessControl([Security.AccessControl.AccessControlSections]'Access, Owner')
$rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [pscustomobject]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = [int64]$_.FileSystemRights }
})
[pscustomobject]@{
  owner = $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value
  currentUser = $sid.Value
  protected = $verified.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;

const PRIVATE_FILE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:PTT_ACL_TARGET)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $sid,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule) | Out-Null
[IO.File]::SetAccessControl($target, $acl)
$verified = [IO.File]::GetAccessControl($target, [Security.AccessControl.AccessControlSections]'Access, Owner')
$rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [pscustomobject]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = [int64]$_.FileSystemRights }
})
[pscustomobject]@{
  owner = $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value
  currentUser = $sid.Value
  protected = $verified.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;

function powershellAcl(script: string, target: string, timeoutMs = 10_000): WindowsAclEvidence {
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: Math.max(1, timeoutMs),
    env: { ...process.env, PTT_ACL_TARGET: target },
  });
  const value = JSON.parse(output) as WindowsAclEvidence;
  if (typeof value?.owner !== "string" || typeof value.currentUser !== "string" ||
    typeof value.protected !== "boolean" || !Array.isArray(value.rules)) {
    throw new Error("Windows runtime ACL inspection returned invalid evidence");
  }
  return value;
}

function assertPrivateAcl(evidence: WindowsAclEvidence): void {
  const fullControl = 0x1f01ff;
  if (!evidence.protected || evidence.owner !== evidence.currentUser || evidence.rules.length !== 1 ||
    evidence.rules[0].identity !== evidence.currentUser || evidence.rules[0].type !== "Allow" ||
    (evidence.rules[0].rights & fullControl) !== fullControl) {
    throw new Error("Codex Goal runtime path is not protected by a current-user-only Windows DACL");
  }
}

function protectPrivateDirectory(target: string): void {
  assertNoReparsePath(target);
  assertPrivateAcl(powershellAcl(PRIVATE_DIRECTORY_ACL_SCRIPT, target));
  assertNoReparsePath(target);
}

function protectPrivateFile(target: string, timeoutMs = 10_000): void {
  assertNoReparsePath(target);
  assertPrivateAcl(powershellAcl(PRIVATE_FILE_ACL_SCRIPT, target, timeoutMs));
  assertNoReparsePath(target);
}

function verifyPrivatePath(target: string, timeoutMs = 10_000): void {
  assertNoReparsePath(target);
  assertPrivateAcl(powershellAcl(INSPECT_ACL_SCRIPT, target, timeoutMs));
  assertNoReparsePath(target);
}

function windowsLocalAppData(): string {
  if (process.platform !== "win32") throw new Error("Codex Goal runtime private root is Windows-only");
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  }).trim();
  if (!output || !path.isAbsolute(output) || !fs.existsSync(output)) {
    throw new Error("Windows LocalApplicationData known folder could not be resolved");
  }
  const resolved = fs.realpathSync.native(output);
  assertNoReparsePath(resolved);
  return resolved;
}

function privateAppRoot(override?: string): string {
  const localAppData = override == null ? windowsLocalAppData() : path.dirname(path.resolve(override));
  assertNoReparsePath(localAppData);
  const root = override == null ? path.join(localAppData, "PassTheThread") : path.resolve(override);
  fs.mkdirSync(root, { recursive: true });
  protectPrivateDirectory(root);
  return root;
}

function prepareGoalRpcFence(codexHome: string, appRoot?: string): string {
  const resolvedHome = path.resolve(codexHome);
  assertNoReparsePath(resolvedHome);
  const fenceRoot = path.join(privateAppRoot(appRoot), "rpc-fences");
  fs.mkdirSync(fenceRoot, { recursive: true });
  protectPrivateDirectory(fenceRoot);
  const identity = canonical(resolvedHome);
  const fencePath = path.join(fenceRoot, `${createHash("sha256").update(identity, "utf8").digest("hex")}.sqlite`);
  if (!fs.existsSync(fencePath)) {
    const handle = fs.openSync(fencePath, "wx");
    fs.closeSync(handle);
    protectPrivateFile(fencePath);
  } else {
    const stat = fs.lstatSync(fencePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Codex Goal RPC fence path was replaced");
    verifyPrivatePath(fencePath);
  }
  const database = new (requireDatabaseSync())(fencePath);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS target_binding (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), codex_home TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS set_invocations_v2 (
        thread_id TEXT PRIMARY KEY NOT NULL,
        operation_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        profile_fingerprint TEXT NOT NULL,
        nonce TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'cancelled'))
      )
    `);
    database.prepare("INSERT OR IGNORE INTO target_binding(singleton, codex_home) VALUES (1, ?)").run(identity);
    const binding = database.prepare("SELECT codex_home FROM target_binding WHERE singleton = 1").get() as { codex_home?: unknown } | undefined;
    if (binding?.codex_home !== identity) throw new Error("Codex Goal RPC fence belongs to a different Codex home");
  } finally { database.close(); }
  verifyPrivatePath(fencePath);
  return fencePath;
}

function validateGoalSetBinding(binding: CodexGoalSetBinding, threadId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.operationId) ||
    binding.targetThreadId !== threadId || binding.capabilityId !== CODEX_GOAL_TARGET_CAPABILITY_ID ||
    binding.profileFingerprint !== CODEX_GOAL_TARGET_FINGERPRINT) {
    throw new Error("invalid Codex Goal RPC operation binding");
  }
}

function reserveGoalSet(fencePath: string, binding: CodexGoalSetBinding): string {
  validateGoalSetBinding(binding, binding.targetThreadId);
  const threadId = binding.targetThreadId;
  const nonce = createHash("sha256")
    .update(`${process.pid}\0${Date.now()}\0${Math.random()}\0${threadId}`, "utf8").digest("hex");
  const database = new DatabaseSync(fencePath);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    const current = database.prepare(`
      SELECT operation_id, capability_id, profile_fingerprint, state
      FROM set_invocations_v2 WHERE thread_id = ?
    `).get(threadId) as { operation_id?: unknown; capability_id?: unknown; profile_fingerprint?: unknown; state?: unknown } | undefined;
    if (current != null && current.state !== "completed" && current.state !== "cancelled") {
      throw new Error(`Codex Goal thread has an unresolved set reservation: ${String(current.state)}`);
    }
    database.prepare(`
      INSERT INTO set_invocations_v2(
        thread_id, operation_id, capability_id, profile_fingerprint, nonce, state
      ) VALUES (?, ?, ?, ?, ?, 'pending')
      ON CONFLICT(thread_id) DO UPDATE SET
        operation_id = excluded.operation_id,
        capability_id = excluded.capability_id,
        profile_fingerprint = excluded.profile_fingerprint,
        nonce = excluded.nonce,
        state = excluded.state
    `).run(threadId, binding.operationId, binding.capabilityId, binding.profileFingerprint, nonce);
    database.exec("COMMIT");
    return nonce;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { database.close(); }
}

function cancelUnstartedGoalSet(fencePath: string, binding: CodexGoalSetBinding): void {
  validateGoalSetBinding(binding, binding.targetThreadId);
  const database = new DatabaseSync(fencePath);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    const current = database.prepare(`
      SELECT operation_id, capability_id, profile_fingerprint, state
      FROM set_invocations_v2 WHERE thread_id = ?
    `).get(binding.targetThreadId) as
      { operation_id?: unknown; capability_id?: unknown; profile_fingerprint?: unknown; state?: unknown } | undefined;
    if (current?.state === "claimed") {
      throw new Error("Codex Goal set was claimed by a worker; automatic recovery cannot prove its app-server child is dead");
    }
    if (current != null && current.state !== "completed" && current.state !== "cancelled" &&
      (current.operation_id !== binding.operationId || current.capability_id !== binding.capabilityId ||
        current.profile_fingerprint !== binding.profileFingerprint)) {
      throw new Error("Codex Goal set reservation belongs to a different operation or capability");
    }
    database.prepare(`
      UPDATE set_invocations_v2 SET state = 'cancelled'
      WHERE thread_id = ? AND operation_id = ? AND capability_id = ? AND profile_fingerprint = ?
        AND state = 'pending'
    `).run(binding.targetThreadId, binding.operationId, binding.capabilityId, binding.profileFingerprint);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { database.close(); }
}

function requireDatabaseSync(): typeof import("node:sqlite").DatabaseSync {
  // Kept behind a helper so the runtime fence setup has one auditable native
  // SQLite entry point in both production and tests.
  return DatabaseSync;
}

const RUNTIME_LEASE_SCHEMA = "pass-the-thread/runtime-lease-v2" as const;
const RUNTIME_LEASE_REAPER_MAX_CANDIDATES = 2;
const RUNTIME_LEASE_REAPER_BUDGET_MS = 15_000;
const RUNTIME_LEASE_CURSOR_DB = "reaper.sqlite";

interface RuntimeLeaseMarker {
  schema: typeof RUNTIME_LEASE_SCHEMA;
  directory: string;
  ownerPid: number;
  ownerStartedAtMs: number;
  createdAtMs: number;
  executableSha256: string;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

type ProcessIdentity =
  | { status: "running"; startedAtMs: number }
  | { status: "missing" | "unknown" };

function queryProcessIdentity(pid: number, timeoutMs: number): ProcessIdentity {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:PTT_OWNER_PID
$owner = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($null -eq $owner) { 'missing'; exit 0 }
try {
  ([DateTimeOffset]$owner.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)
} catch { 'unknown' }
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: Math.max(1, timeoutMs),
      env: { ...process.env, PTT_OWNER_PID: String(pid) },
    }).trim();
    if (output === "missing" || output === "unknown") return { status: output };
    const startedAtMs = Number(output);
    if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) return { status: "unknown" };
    return { status: "running", startedAtMs };
  } catch {
    return { status: "unknown" };
  }
}

function executableIsRunning(executable: string, timeoutMs = 10_000): boolean {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:PTT_RUNTIME_EXE)
$found = $false
Get-Process | ForEach-Object {
  try { if ($_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $target) { $found = $true } } catch {}
}
if ($found) { 'true' } else { 'false' }
`;
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: Math.max(1, timeoutMs),
    env: { ...process.env, PTT_RUNTIME_EXE: executable },
  }).trim();
  if (output !== "true" && output !== "false") throw new Error("invalid runtime process-liveness evidence");
  return output === "true";
}

function sha256FileWithTimeout(target: string, timeoutMs: number): string {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::OpenRead($env:PTT_HASH_TARGET)
try {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
} finally { $stream.Dispose() }
`;
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: Math.max(1, timeoutMs),
    env: { ...process.env, PTT_HASH_TARGET: target },
  }).trim();
  if (!/^[0-9a-f]{64}$/.test(output)) throw new Error("invalid bounded runtime hash evidence");
  return output;
}

function validateLeaseMarker(value: unknown, directory: string): RuntimeLeaseMarker {
  if (!isRecord(value) || value.schema !== RUNTIME_LEASE_SCHEMA ||
    value.directory !== path.basename(directory) || typeof value.ownerPid !== "number" ||
    !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0 ||
    typeof value.ownerStartedAtMs !== "number" || !Number.isSafeInteger(value.ownerStartedAtMs) || value.ownerStartedAtMs <= 0 ||
    typeof value.createdAtMs !== "number" || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs <= 0 ||
    typeof value.executableSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.executableSha256)) {
    throw new Error("invalid Codex Goal runtime lease marker");
  }
  return value as unknown as RuntimeLeaseMarker;
}

function cleanupExactLease(
  root: string,
  expectedSha256: string,
  retryMs: number,
): void {
  const target = path.join(root, `${expectedSha256}.exe`);
  const stage = path.join(root, "runtime.stage");
  const markerPath = path.join(root, "lease.json");
  const cleanup = (): void => {
    assertNoReparsePath(root);
    const allowed = new Set([path.basename(target), path.basename(stage), path.basename(markerPath)]);
    for (const entry of fs.readdirSync(root)) {
      if (!allowed.has(entry)) throw new Error("Codex Goal runtime lease contains an unexpected entry");
    }
    for (const candidate of [stage, target, markerPath]) {
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Codex Goal runtime lease was replaced");
      fs.rmSync(candidate);
    }
    fs.rmdirSync(root);
  };
  const deadline = Date.now() + retryMs;
  let lastError: unknown;
  do {
    try { cleanup(); return; }
    catch (error) { lastError = error; }
    if (Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  } while (true);
  throw lastError;
}

interface RuntimeLeaseReaperOptions {
  budgetMs?: number;
  maxCandidates?: number;
  now?: () => number;
  beforeCleanup?: () => void;
  inspectCandidate?: (name: string) => void;
  afterStageCommit?: () => void;
}

interface RuntimeLeaseReaperResult {
  examined: number;
  cleaned: number;
  deferred: boolean;
}

interface OpenRuntimeLeaseCursor {
  after: string | null;
  advance(name: string): void;
  close(commit: boolean): void;
}

interface RuntimeLeaseCursorStageIdentity {
  ownerPid: number;
  ownerStartedAtMs: number;
  createdAtMs: number;
}

function initializeRuntimeLeaseCursorDatabase(
  cursorPath: string,
  identity: RuntimeLeaseCursorStageIdentity,
): void {
  const database = new (requireDatabaseSync())(cursorPath);
  try {
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS reaper_cursor (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        after_name TEXT
      ) STRICT;
      INSERT OR IGNORE INTO reaper_cursor(singleton, after_name) VALUES (1, NULL);
      CREATE TABLE IF NOT EXISTS cursor_stage_meta (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        owner_pid INTEGER NOT NULL,
        owner_started_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS stage_reaper_cursor (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        after_name TEXT
      ) STRICT;
      INSERT OR IGNORE INTO stage_reaper_cursor(singleton, after_name) VALUES (1, NULL);
    `);
    database.prepare(`
      INSERT OR REPLACE INTO cursor_stage_meta(
        singleton, owner_pid, owner_started_at_ms, created_at_ms
      ) VALUES (1, ?, ?, ?)
    `).run(identity.ownerPid, identity.ownerStartedAtMs, identity.createdAtMs);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { database.close(); }
}

function prepareRuntimeLeaseCursorStage(
  perUserRoot: string,
  timeoutMs: number,
  override?: RuntimeLeaseCursorStageIdentity,
): string {
  const currentOwner = queryProcessIdentity(process.pid, timeoutMs);
  if (override == null && currentOwner.status !== "running") {
    throw new Error("Codex Goal cursor stage owner identity could not be established");
  }
  const identity = override ?? {
    ownerPid: process.pid,
    ownerStartedAtMs: (currentOwner as { status: "running"; startedAtMs: number }).startedAtMs,
    createdAtMs: Date.now(),
  };
  const stagePath = path.join(perUserRoot,
    `reaper-stage-${identity.createdAtMs}-${identity.ownerPid}-${randomUUID()}.sqlite`);
  const handle = fs.openSync(stagePath, "wx");
  fs.closeSync(handle);
  try {
    protectPrivateFile(stagePath, timeoutMs);
    initializeRuntimeLeaseCursorDatabase(stagePath, identity);
    verifyPrivatePath(stagePath, timeoutMs);
    const stat = fs.lstatSync(stagePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw new Error("Codex Goal runtime lease cursor stage was replaced");
    }
    return stagePath;
  } catch (error) {
    try {
      const stat = fs.lstatSync(stagePath);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.rmSync(stagePath);
    } catch {}
    throw error;
  }
}

function reapAbandonedRuntimeLeaseCursorStages(
  perUserRoot: string,
  database: DatabaseSync,
  timeoutMs: number,
): void {
  const deadline = Date.now() + timeoutMs;
  const script = String.raw`
const fs = require("node:fs");
const root = process.env.PTT_LEASE_ROOT;
const after = process.env.PTT_STAGE_AFTER || null;
const take = 4;
const greater = [];
const wrapped = [];
function retainSmallest(bucket, name) {
  bucket.push(name);
  bucket.sort();
  if (bucket.length > take) bucket.pop();
}
const directory = fs.opendirSync(root);
try {
  for (;;) {
    const entry = directory.readSync();
    if (entry == null) break;
    if (!/^reaper-stage-[0-9]+-[0-9]+-[0-9a-f-]{36}\.sqlite$/.test(entry.name)) continue;
    retainSmallest(after == null || entry.name > after ? greater : wrapped, entry.name);
  }
} finally { directory.closeSync(); }
const names = greater.slice(0, take);
if (names.length < take) names.push(...wrapped.slice(0, take - names.length));
process.stdout.write(JSON.stringify(names));
`;
  const cursorRow = database.prepare("SELECT after_name FROM stage_reaper_cursor WHERE singleton = 1").get() as
    { after_name?: unknown } | undefined;
  const afterName = cursorRow?.after_name;
  if (!(afterName === null || (typeof afterName === "string" &&
    /^reaper-stage-[0-9]+-[0-9]+-[0-9a-f-]{36}\.sqlite$/.test(afterName)))) return;
  let names: unknown;
  try {
    names = JSON.parse(execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8", windowsHide: true, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 16 * 1024,
      env: { ...process.env, PTT_LEASE_ROOT: perUserRoot, PTT_STAGE_AFTER: afterName ?? "" },
    }));
  } catch { return; }
  if (!Array.isArray(names)) return;
  for (const name of names) {
    if (Date.now() >= deadline || typeof name !== "string") break;
    const match = /^reaper-stage-([0-9]+)-([0-9]+)-[0-9a-f-]{36}\.sqlite$/.exec(name);
    if (match == null) continue;
    database.prepare("UPDATE stage_reaper_cursor SET after_name = ? WHERE singleton = 1").run(name);
    const stagePath = path.join(perUserRoot, name);
    try {
      const before = fs.lstatSync(stagePath);
      if (!before.isFile() || before.isSymbolicLink()) continue;
      verifyPrivatePath(stagePath, Math.max(1, deadline - Date.now()));
      const createdAtMs = Number(match[1]);
      const ownerPid = Number(match[2]);
      if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(ownerPid) ||
        Date.now() - createdAtMs < 30_000) continue;
      if (["-journal", "-wal", "-shm"].some((suffix) => fs.existsSync(`${stagePath}${suffix}`))) continue;
      const database = new (requireDatabaseSync())(stagePath, { readOnly: true });
      let metadata: { owner_pid?: unknown; owner_started_at_ms?: unknown; created_at_ms?: unknown } | undefined;
      try {
        const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
        if (integrity?.integrity_check !== "ok") continue;
        const tables = database.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `).all() as Array<{ name?: unknown }>;
        if (stableStringify(tables.map((row) => row.name)) !==
          stableStringify(["cursor_stage_meta", "reaper_cursor", "stage_reaper_cursor"])) continue;
        metadata = database.prepare(`
          SELECT owner_pid, owner_started_at_ms, created_at_ms
          FROM cursor_stage_meta WHERE singleton = 1
        `).get() as typeof metadata;
      } finally { database.close(); }
      if (metadata?.owner_pid !== ownerPid || metadata.created_at_ms !== createdAtMs ||
        typeof metadata.owner_started_at_ms !== "number" ||
        !Number.isSafeInteger(metadata.owner_started_at_ms) || metadata.owner_started_at_ms <= 0) continue;
      const owner = queryProcessIdentity(ownerPid, Math.max(1, deadline - Date.now()));
      if (owner.status === "unknown" ||
        (owner.status === "running" && owner.startedAtMs === metadata.owner_started_at_ms)) continue;
      verifyPrivatePath(stagePath, Math.max(1, deadline - Date.now()));
      const after = fs.lstatSync(stagePath);
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) continue;
      fs.rmSync(stagePath);
    } catch {
      // Partial, live, inaccessible, or changing cursor stages remain evidence.
    }
  }
}

function publishRuntimeLeaseCursor(perUserRoot: string, cursorPath: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  if (fs.existsSync(cursorPath)) return;
  const stagePath = prepareRuntimeLeaseCursorStage(perUserRoot, Math.max(1, deadline - Date.now()));
  try {
    try { fs.linkSync(stagePath, cursorPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    verifyPrivatePath(cursorPath, Math.max(1, deadline - Date.now()));
    const stat = fs.lstatSync(cursorPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw new Error("Codex Goal runtime lease cursor publication failed");
    }
  } finally {
    try {
      const stat = fs.lstatSync(stagePath);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.rmSync(stagePath);
    } catch {}
  }
}

function openRuntimeLeaseCursor(
  perUserRoot: string,
  timeoutMs: number,
  afterStageCommit?: () => void,
): OpenRuntimeLeaseCursor {
  const deadline = Date.now() + timeoutMs;
  const remainingMs = (): number => Math.max(1, deadline - Date.now());
  const cursorPath = path.join(perUserRoot, RUNTIME_LEASE_CURSOR_DB);
  publishRuntimeLeaseCursor(perUserRoot, cursorPath, remainingMs());
  verifyPrivatePath(cursorPath, remainingMs());
  const database = new (requireDatabaseSync())(cursorPath);
  let transaction = false;
  try {
    database.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.min(remainingMs(), 15_000))}`);
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE");
    transaction = true;
    database.exec(`
      CREATE TABLE IF NOT EXISTS reaper_cursor (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        after_name TEXT
      ) STRICT;
      INSERT OR IGNORE INTO reaper_cursor(singleton, after_name) VALUES (1, NULL);
      CREATE TABLE IF NOT EXISTS stage_reaper_cursor (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        after_name TEXT
      ) STRICT;
      INSERT OR IGNORE INTO stage_reaper_cursor(singleton, after_name) VALUES (1, NULL);
    `);
    reapAbandonedRuntimeLeaseCursorStages(perUserRoot, database, remainingMs());
    // Stage progress has its own crash boundary. Commit it before the lease
    // selector so a later timeout cannot roll back into the same preserved
    // stage prefix forever, then reacquire the shared exclusive transaction.
    database.exec("COMMIT");
    transaction = false;
    afterStageCommit?.();
    const reacquireBudget = deadline - Date.now();
    if (reacquireBudget <= 0) throw new Error("Codex Goal runtime lease cursor deadline expired");
    database.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.min(reacquireBudget, 15_000))}`);
    database.exec("BEGIN EXCLUSIVE");
    transaction = true;
    const row = database.prepare("SELECT after_name FROM reaper_cursor WHERE singleton = 1").get() as
      { after_name?: unknown } | undefined;
    const after = row?.after_name;
    if (!(after === null || (typeof after === "string" && /^lease-[A-Za-z0-9_-]+$/.test(after)))) {
      throw new Error("invalid Codex Goal runtime lease cursor state");
    }
    return {
      after,
      advance(name: string): void {
        database.prepare("UPDATE reaper_cursor SET after_name = ? WHERE singleton = 1").run(name);
        this.after = name;
      },
      close(commit: boolean): void {
        try { database.exec(commit ? "COMMIT" : "ROLLBACK"); }
        finally { transaction = false; database.close(); }
      },
    };
  } catch (error) {
    if (transaction) { try { database.exec("ROLLBACK"); } catch {} }
    database.close();
    throw error;
  }
}

function selectRuntimeLeaseNames(
  perUserRoot: string,
  after: string | null,
  maxCandidates: number,
  timeoutMs: number,
): { names: string[]; hasMore: boolean } {
  const script = String.raw`
const fs = require("node:fs");
const root = process.env.PTT_LEASE_ROOT;
const after = process.env.PTT_LEASE_AFTER || null;
const take = Number(process.env.PTT_LEASE_TAKE);
const greater = [];
const wrapped = [];
let total = 0;
function retainSmallest(bucket, name) {
  bucket.push(name);
  bucket.sort();
  if (bucket.length > take) bucket.pop();
}
const directory = fs.opendirSync(root);
try {
  for (;;) {
    const entry = directory.readSync();
    if (entry == null) break;
    if (!/^lease-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    total += 1;
    retainSmallest(after == null || entry.name > after ? greater : wrapped, entry.name);
  }
} finally { directory.closeSync(); }
const names = greater.slice(0, take);
if (names.length < take) names.push(...wrapped.slice(0, take - names.length));
process.stdout.write(JSON.stringify({ names, hasMore: total > names.length }));
`;
  const output = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: Math.max(1, timeoutMs),
    maxBuffer: 64 * 1024,
    env: {
      ...process.env,
      PTT_LEASE_ROOT: perUserRoot,
      PTT_LEASE_AFTER: after ?? "",
      PTT_LEASE_TAKE: String(maxCandidates),
    },
  });
  const value = JSON.parse(output) as unknown;
  if (!isRecord(value) || !Array.isArray(value.names) || typeof value.hasMore !== "boolean" ||
    value.names.length > maxCandidates ||
    value.names.some((name) => typeof name !== "string" || !/^lease-[A-Za-z0-9_-]+$/.test(name))) {
    throw new Error("invalid bounded runtime lease enumeration result");
  }
  return { names: value.names as string[], hasMore: value.hasMore };
}

function reapStaleRuntimeLeases(
  perUserRoot: string,
  options: RuntimeLeaseReaperOptions = {},
): RuntimeLeaseReaperResult {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? RUNTIME_LEASE_REAPER_BUDGET_MS;
  const maxCandidates = options.maxCandidates ?? RUNTIME_LEASE_REAPER_MAX_CANDIDATES;
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 ||
    !Number.isSafeInteger(maxCandidates) || maxCandidates <= 0 || maxCandidates > 1_000) {
    throw new Error("invalid Codex Goal runtime lease reaper budget");
  }
  const deadline = now() + budgetMs;
  let examined = 0;
  let cleaned = 0;
  let deferred = false;
  const remainingMs = (): number => Math.max(0, deadline - now());
  let cursor: OpenRuntimeLeaseCursor | undefined;
  let commitCursor = false;
  try {
    if (remainingMs() <= 0) return { examined, cleaned, deferred: true };
    cursor = openRuntimeLeaseCursor(perUserRoot, remainingMs(), options.afterStageCommit);
    if (remainingMs() <= 0) return { examined, cleaned, deferred: true };
    const selection = selectRuntimeLeaseNames(perUserRoot, cursor.after, maxCandidates, remainingMs());
    for (const name of selection.names) {
      if (examined >= maxCandidates || remainingMs() <= 0) { deferred = true; break; }
      // Advance before expensive inspection. A crash or timeout defers this
      // candidate until the cursor wraps instead of starving every later one.
      cursor.advance(name);
      examined += 1;
      if (options.inspectCandidate != null) {
        options.inspectCandidate(name);
        continue;
      }
      const root = path.join(perUserRoot, name);
      try {
        const stat = fs.lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        verifyPrivatePath(root, remainingMs());
        const markerPath = path.join(root, "lease.json");
        if (!fs.existsSync(markerPath)) continue;
        verifyPrivatePath(markerPath, remainingMs());
        const marker = validateLeaseMarker(JSON.parse(fs.readFileSync(markerPath, "utf8")), root);
        if (now() - marker.createdAtMs < 30_000) continue;
        const ownerBudget = remainingMs();
        if (ownerBudget <= 0) { deferred = true; continue; }
        const owner = queryProcessIdentity(marker.ownerPid, ownerBudget);
        if (owner.status === "unknown") { deferred = true; continue; }
        if (owner.status === "running" && owner.startedAtMs === marker.ownerStartedAtMs) continue;
        const executable = path.join(root, `${marker.executableSha256}.exe`);
        if (fs.existsSync(executable)) {
          verifyPrivatePath(executable, remainingMs());
          if (remainingMs() <= 0 ||
            sha256FileWithTimeout(executable, remainingMs()) !== marker.executableSha256 ||
            remainingMs() <= 0 || executableIsRunning(executable, remainingMs())) continue;
        }
        options.beforeCleanup?.();
        const cleanupBudget = remainingMs();
        if (cleanupBudget <= 0) { deferred = true; continue; }
        cleanupExactLease(root, marker.executableSha256, Math.min(2_000, cleanupBudget));
        cleaned += 1;
      } catch {
        // A malformed, live, inaccessible, changing, or over-budget lease is
        // not ours to delete automatically. Leave it for explicit inspection.
        deferred = true;
      }
    }
    if (selection.hasMore || examined < selection.names.length) deferred = true;
    commitCursor = true;
    return { examined, cleaned, deferred };
  } catch {
    return { examined, cleaned, deferred: true };
  } finally {
    try { cursor?.close(commitCursor); } catch {}
  }
}

function runnableExecutable(installedExe: string, expectedSha256: string, appRoot?: string): RuntimeLease {
  if (process.platform !== "win32" || !/\\WindowsApps\\/i.test(installedExe)) {
    return { executable: installedExe, verify(): void {}, dispose(): void {} };
  }
  // Windows permits hashing the packaged artifact but can deny CreateProcess to
  // non-AppContainer callers. Use a unique user-temp lease instead of a shared
  // cache, reject reparse traversal, publish with a no-overwrite hard link, and
  // re-hash both before publication and before every execution.
  const perUserRoot = path.join(privateAppRoot(appRoot), "runtime-leases");
  fs.mkdirSync(perUserRoot, { recursive: true });
  protectPrivateDirectory(perUserRoot);
  reapStaleRuntimeLeases(perUserRoot);
  const root = fs.mkdtempSync(path.join(perUserRoot, "lease-"));
  protectPrivateDirectory(root);
  const normalizedSha256 = expectedSha256.toLowerCase();
  const target = path.join(root, `${normalizedSha256}.exe`);
  const stage = path.join(root, "runtime.stage");
  const markerPath = path.join(root, "lease.json");
  const owner = queryProcessIdentity(process.pid, 10_000);
  if (owner.status !== "running") {
    try { cleanupExactLease(root, normalizedSha256, 0); } catch {}
    throw new Error("Codex Goal runtime owner process identity could not be established");
  }
  const marker: RuntimeLeaseMarker = {
    schema: RUNTIME_LEASE_SCHEMA,
    directory: path.basename(root),
    ownerPid: process.pid,
    ownerStartedAtMs: owner.startedAtMs,
    createdAtMs: Date.now(),
    executableSha256: normalizedSha256,
  };
  try {
    fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" });
    protectPrivateFile(markerPath);
    fs.copyFileSync(installedExe, stage, fs.constants.COPYFILE_EXCL);
    if (sha256File(stage).toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error("copied Codex Goal runtime hash does not match the audited executable");
    }
    fs.linkSync(stage, target);
    protectPrivateFile(target);
    if (fs.existsSync(stage)) fs.rmSync(stage, { force: true });
    verifyPrivatePath(target);
    if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink() ||
      sha256File(target).toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error("published Codex Goal runtime failed final validation");
    }
  } catch (error) {
    try { cleanupExactLease(root, normalizedSha256, 0); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Codex Goal runtime lease setup and cleanup failed");
    }
    throw error;
  }
  return {
    executable: target,
    verify(): void {
      verifyPrivatePath(root);
      verifyPrivatePath(target);
      if (sha256File(target).toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error("Codex Goal runtime lease changed before execution");
      }
    },
    dispose(): void {
      // The unique directory was created by this process. Refuse recursive
      // cleanup: unexpected entries or path substitution leave evidence behind.
      cleanupExactLease(root, normalizedSha256, 10_000);
    },
  };
}

interface CodexGoalRpcInternalOptions {
  appRoot?: string;
  rpcRunner?: typeof runRpc;
  workerControl?: RpcWorkerControl;
}

function createCodexGoalRpcInternal(
  evidence: CodexTargetEvidence,
  codexHome: string,
  internal: CodexGoalRpcInternalOptions = {},
): CodexGoalRpc {
  assertSupportedCodexTarget(evidence);
  const installedExe = evidence.codexExePath;
  if (typeof installedExe !== "string" || !fs.existsSync(installedExe)) {
    throw new Error("verified Codex executable path is required for live Goal activation");
  }
  if (sha256File(installedExe).toLowerCase() !== evidence.codexExeSha256.toLowerCase()) {
    throw new Error("Codex Goal runtime executable hash changed after planning");
  }
  const lease = runnableExecutable(installedExe, evidence.codexExeSha256, internal.appRoot);
  let fencePath: string;
  try { fencePath = prepareGoalRpcFence(codexHome, internal.appRoot); }
  catch (error) {
    try { lease.dispose(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Codex Goal fence setup and runtime cleanup failed");
    }
    throw error;
  }
  let disposed = false;
  const call = (method: string, params: unknown, binding?: CodexGoalSetBinding): RpcWorkerResult => {
    if (disposed) throw new Error("Codex Goal RPC runtime lease is closed");
    lease.verify();
    const threadId = isRecord(params) && typeof params.threadId === "string" ? params.threadId : null;
    if (method === "thread/goal/get") {
      if (threadId == null) throw new Error("Codex Goal get requires a thread id");
      if (binding == null) throw new Error("Codex Goal get requires an operation binding");
      validateGoalSetBinding(binding, threadId);
      // Invalidate a spawned-but-not-yet-scheduled set worker while holding the
      // same OS fence it must acquire. A delayed orphan can then acquire the
      // fence but cannot pass its durable nonce check or spawn app-server.
      cancelUnstartedGoalSet(fencePath, binding);
    }
    if (method === "thread/goal/set" && (threadId == null || binding == null)) {
      throw new Error("Codex Goal set requires an operation binding");
    }
    const setNonce = method === "thread/goal/set" ? reserveGoalSet(fencePath, binding!) : "";
    const rpcParams = method === "thread/goal/set"
      ? { ...(params as Record<string, unknown>), __operationId: binding!.operationId,
        __capabilityId: binding!.capabilityId, __profileFingerprint: binding!.profileFingerprint }
      : params;
    return (internal.rpcRunner ?? runRpc)(
      lease.executable, evidence, codexHome, fencePath, method, rpcParams, setNonce,
      method === "thread/goal/set" ? internal.workerControl : undefined,
    );
  };
  return {
    probe(): void { call("probe", {}); },
    get(threadId: string, binding: CodexGoalSetBinding): CodexThreadGoal | null {
      return parseCodexGoalGetResult(call("thread/goal/get", { threadId }, binding).result);
    },
    set(request: CodexGoalExpectedReadback, binding: CodexGoalSetBinding): CodexThreadGoal {
      return parseCodexGoalSetResult(call("thread/goal/set", request, binding).result);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      lease.dispose();
    },
  };
}

export function createCodexGoalRpc(evidence: CodexTargetEvidence, codexHome: string): CodexGoalRpc {
  return createCodexGoalRpcInternal(evidence, codexHome);
}

/** Test-only hooks. Production callers must use createCodexGoalRpc. */
export const codexGoalTargetTesting = {
  processIsAlive(pid: number): boolean {
    return processIsAlive(pid);
  },
  reapRuntimeLeases(
    perUserRoot: string,
    options?: RuntimeLeaseReaperOptions,
  ): RuntimeLeaseReaperResult {
    return reapStaleRuntimeLeases(perUserRoot, options);
  },
  beginRuntimeLeaseCursor(
    perUserRoot: string,
    timeoutMs: number,
  ): { after: string | null; advance(name: string): void; close(commit: boolean): void } {
    return openRuntimeLeaseCursor(perUserRoot, timeoutMs);
  },
  prepareAbandonedRuntimeLeaseCursorStage(
    perUserRoot: string,
    timeoutMs: number,
    identity: { ownerPid: number; ownerStartedAtMs: number; createdAtMs: number },
  ): string {
    return prepareRuntimeLeaseCursorStage(perUserRoot, timeoutMs, identity);
  },
  protectDirectory(target: string): void {
    protectPrivateDirectory(target);
  },
  protectFile(target: string): void {
    protectPrivateFile(target);
  },
  prepareFence(codexHome: string, appRoot: string): string {
    return prepareGoalRpcFence(codexHome, appRoot);
  },
  createRpc(
    evidence: CodexTargetEvidence,
    codexHome: string,
    appRoot: string,
    rpcRunner: typeof runRpc,
  ): CodexGoalRpc {
    return createCodexGoalRpcInternal(evidence, codexHome, { appRoot, rpcRunner });
  },
  createProductionRpcWithControl(
    evidence: CodexTargetEvidence,
    codexHome: string,
    workerControl: RpcWorkerControl,
  ): CodexGoalRpc {
    return createCodexGoalRpcInternal(evidence, codexHome, { workerControl });
  },
  reserveSet(fencePath: string, binding: CodexGoalSetBinding): string {
    return reserveGoalSet(fencePath, binding);
  },
  cancelSet(fencePath: string, binding: CodexGoalSetBinding): void {
    cancelUnstartedGoalSet(fencePath, binding);
  },
};
