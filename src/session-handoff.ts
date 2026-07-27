import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalProjectIdentity } from "./project-identity.ts";

export const MAX_HANDOFF_HEADER_BYTES = 16 * 1024;
export const MAX_HANDOFF_BODY_BYTES = 8 * 1024 * 1024;
export const HANDOFF_SCHEMA = "threadpass.session-handoff/v1";

const HEADER_LEAD = "<!-- threadpass-handoff:v1;bytes=";
const HEADER_LENGTH_DIGITS = 5;
const HEADER_LEAD_BYTES = Buffer.byteLength(HEADER_LEAD) + HEADER_LENGTH_DIGITS;
const HEADER_FAMILY_PREFIX = Buffer.from("<!-- threadpass-handoff", "utf8");
const HEADER_SUFFIX = Buffer.from("\n-->\n", "utf8");
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HEADER_SNIFF_BYTES = UTF8_BOM.length + HEADER_LEAD_BYTES + 2;
const SESSION_FILE_PATTERN = /-session\.tmp$/;
const MAX_READ_CALLS_PER_REGION = 8;

export type HandoffProjectIdentity =
  | { kind: "git"; root: string; gitDir: string }
  | { kind: "directory"; root: string };

export interface SessionHandoffHeader {
  schema: typeof HANDOFF_SCHEMA;
  savedAt: string;
  savedDate: string;
  project: HandoffProjectIdentity;
}

export interface HandoffFileSnapshot {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}

export type InspectedSessionHandoff =
  | { kind: "valid"; header: SessionHandoffHeader; bodyOffset: number }
  | { kind: "legacy"; bodyOffset: 0 }
  | { kind: "invalid"; reason: string; bodyOffset: null };

export interface ResolveSessionHandoffOptions {
  cwd?: string;
  explicitFile?: string;
  date?: string;
  allowCrossProject?: boolean;
  /** Narrow test/integration seam. CLI callers use the canonical stores. */
  sessionDirectories?: string[];
  /** Test-only race seam; production CLI never supplies this callback. */
  testingBeforeResolveReturn?: () => void;
}

export interface ReadSessionHandoffOptions extends ResolveSessionHandoffOptions {
  /** Test-only race seam; production CLI never supplies this callback. */
  testingBeforeBodyRead?: () => void;
}

export interface RejectedSessionHandoffCandidate {
  path: string;
  reason: string;
}

export interface SessionHandoffResolution {
  resolvedPath: string | null;
  bodyOffset: number | null;
  verdict: "accepted" | "no-match" | "rejected";
  warnings: string[];
  reason?: string;
  header: SessionHandoffHeader | null;
  /** Discovered candidates that failed header inspection; never silently swallowed. */
  rejectedCandidates: RejectedSessionHandoffCandidate[];
}

export interface SessionHandoffReadResult extends SessionHandoffResolution {
  body: string | null;
  snapshot: HandoffFileSnapshot | null;
}

interface OpenedSelection {
  resolution: SessionHandoffResolution;
  descriptor: number | null;
  snapshot: fs.BigIntStats | null;
}

export function currentHandoffProjectIdentity(cwd: string): HandoffProjectIdentity {
  const current = canonicalProjectIdentity(cwd);
  if (!current.exists) throw new Error(`current project directory does not exist: ${current.path}`);
  if (!fs.statSync(current.path).isDirectory()) {
    throw new Error(`current project path is not a directory: ${current.path}`);
  }
  const gitIdentity = inspectGitWorktree(current.path);
  return gitIdentity ?? { kind: "directory", root: current.path };
}

export function createSessionHandoffHeader(options: {
  cwd?: string;
  savedAt?: string | Date;
} = {}): string {
  const date = options.savedAt instanceof Date
    ? options.savedAt
    : options.savedAt === undefined
      ? new Date()
      : new Date(options.savedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("savedAt must be a valid date-time");
  const header: SessionHandoffHeader = {
    schema: HANDOFF_SCHEMA,
    savedAt: date.toISOString(),
    savedDate: formatLocalDate(date),
    project: currentHandoffProjectIdentity(options.cwd ?? process.cwd()),
  };
  const payload = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.from(`${HEADER_LEAD}${String(payload.length).padStart(HEADER_LENGTH_DIGITS, "0")}\n`, "ascii");
  const rendered = Buffer.concat([prefix, payload, HEADER_SUFFIX]);
  if (rendered.length > MAX_HANDOFF_HEADER_BYTES) {
    throw new Error(`handoff header exceeds ${MAX_HANDOFF_HEADER_BYTES} bytes`);
  }
  return rendered.toString("utf8");
}

export function inspectSessionHandoffHeader(filePath: string): InspectedSessionHandoff {
  let descriptor: number;
  try { descriptor = fs.openSync(filePath, "r"); } catch {
    return { kind: "invalid", reason: `session file does not exist: ${filePath}`, bodyOffset: null };
  }
  try {
    const snapshot = fs.fstatSync(descriptor, { bigint: true });
    return inspectDescriptorSafe(descriptor, snapshot);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function resolveSessionHandoff(options: ResolveSessionHandoffOptions = {}): SessionHandoffResolution {
  const selected = selectOpenedSession(options);
  try {
    if (selected.descriptor === null || selected.snapshot === null || selected.resolution.verdict !== "accepted") {
      return selected.resolution;
    }
    options.testingBeforeResolveReturn?.();
    const after = fs.fstatSync(selected.descriptor, { bigint: true });
    if (!sameSnapshot(selected.snapshot, after)) {
      throw new Error("session file changed while its accepted header was being resolved");
    }
    return selected.resolution;
  } catch (error) {
    return rejected(errorMessage(error), selected.resolution.rejectedCandidates);
  } finally {
    if (selected.descriptor !== null) fs.closeSync(selected.descriptor);
  }
}

export function readSessionHandoff(options: ReadSessionHandoffOptions = {}): SessionHandoffReadResult {
  const selected = selectOpenedSession(options);
  try {
    if (selected.descriptor === null || selected.snapshot === null || selected.resolution.verdict !== "accepted") {
      return { ...selected.resolution, body: null, snapshot: null };
    }
    options.testingBeforeBodyRead?.();
    const offset = selected.resolution.bodyOffset ?? 0;
    const remaining = selected.snapshot.size - BigInt(offset);
    if (remaining < 0n || remaining > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("session body size is invalid or unsupported");
    }
    if (remaining > BigInt(MAX_HANDOFF_BODY_BYTES)) {
      throw new Error(`session body exceeds ${MAX_HANDOFF_BODY_BYTES} bytes`);
    }
    const bodyBytes = readExactAt(selected.descriptor, Number(remaining), offset);
    const after = fs.fstatSync(selected.descriptor, { bigint: true });
    if (!sameSnapshot(selected.snapshot, after)) {
      throw new Error("session file changed while its accepted body was being read");
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    return {
      ...selected.resolution,
      body,
      snapshot: snapshotForJson(selected.snapshot),
    };
  } catch (error) {
    return {
      ...rejected(errorMessage(error), selected.resolution.rejectedCandidates),
      body: null,
      snapshot: null,
    };
  } finally {
    if (selected.descriptor !== null) fs.closeSync(selected.descriptor);
  }
}

function selectOpenedSession(options: ResolveSessionHandoffOptions): OpenedSelection {
  if (options.allowCrossProject && !options.explicitFile) {
    return closed(rejected("--allow-cross-project requires an explicit session file"));
  }
  if (options.explicitFile && options.date) {
    return closed(rejected("an explicit session file and date cannot be used together"));
  }
  if (options.date && !isCalendarDate(options.date)) {
    return closed(rejected("date must be a real calendar date in YYYY-MM-DD format"));
  }
  let current: HandoffProjectIdentity;
  try { current = currentHandoffProjectIdentity(options.cwd ?? process.cwd()); } catch (error) {
    return closed(rejected(errorMessage(error)));
  }
  if (options.explicitFile) {
    return selectExplicit(options.explicitFile, current, options.allowCrossProject === true);
  }

  const directories = options.sessionDirectories ?? defaultSessionDirectories(options.date !== undefined);
  const rejectedCandidates: RejectedSessionHandoffCandidate[] = [];
  let best: OpenedSelection | null = null;
  for (const candidate of enumerateSessionFiles(directories)) {
    const opened = openCandidate(candidate);
    if (opened.descriptor === null || opened.snapshot === null) {
      rejectedCandidates.push({ path: candidate, reason: opened.reason });
      continue;
    }
    const inspected = inspectDescriptorSafe(opened.descriptor, opened.snapshot);
    if (inspected.kind === "invalid") rejectedCandidates.push({ path: candidate, reason: inspected.reason });
    if (inspected.kind !== "valid"
      || !sameHandoffProject(inspected.header.project, current)
      || (options.date !== undefined && inspected.header.savedDate !== options.date)) {
      fs.closeSync(opened.descriptor);
      continue;
    }
    const resolution = accepted(candidate, inspected, []);
    const contender = { resolution, descriptor: opened.descriptor, snapshot: opened.snapshot };
    if (best === null || isPreferred(contender.resolution, best.resolution)) {
      if (best?.descriptor !== null && best?.descriptor !== undefined) fs.closeSync(best.descriptor);
      best = contender;
    } else {
      fs.closeSync(opened.descriptor);
    }
  }
  if (best !== null) {
    best.resolution.rejectedCandidates = rejectedCandidates;
    return best;
  }
  return closed({
    resolvedPath: null,
    bodyOffset: null,
    verdict: rejectedCandidates.length === 0 ? "no-match" : "rejected",
    warnings: [],
    reason: rejectedCandidates.length === 0
      ? "no session handoff matches the exact current project identity"
      : `no session handoff matches the exact current project identity; ${rejectedCandidates.length} candidate(s) failed header inspection`,
    header: null,
    rejectedCandidates,
  });
}

function selectExplicit(
  requestedPath: string,
  current: HandoffProjectIdentity,
  allowCrossProject: boolean,
): OpenedSelection {
  let resolvedPath: string;
  try { resolvedPath = fs.realpathSync.native(path.resolve(requestedPath)); } catch {
    return closed(rejected(`session file does not exist: ${path.resolve(requestedPath)}`));
  }
  const opened = openCandidate(resolvedPath);
  if (opened.descriptor === null || opened.snapshot === null) return closed(rejected(opened.reason));
  const inspected = inspectDescriptorSafe(opened.descriptor, opened.snapshot);
  if (inspected.kind === "invalid") {
    fs.closeSync(opened.descriptor);
    return closed(rejected(inspected.reason));
  }
  if (inspected.kind === "legacy") {
    if (!allowCrossProject) {
      fs.closeSync(opened.descriptor);
      return closed(rejected("headerless legacy sessions require an explicit file and --allow-cross-project"));
    }
    return {
      descriptor: opened.descriptor,
      snapshot: opened.snapshot,
      resolution: {
        resolvedPath,
        bodyOffset: 0,
        verdict: "accepted",
        warnings: ["Headerless legacy session accepted after a bounded format-prefix sniff and explicit cross-project override."],
        header: null,
        rejectedCandidates: [],
      },
    };
  }
  if (sameHandoffProject(inspected.header.project, current)) {
    return { descriptor: opened.descriptor, snapshot: opened.snapshot, resolution: accepted(resolvedPath, inspected, []) };
  }
  if (!allowCrossProject) {
    fs.closeSync(opened.descriptor);
    return closed(rejected("explicit session belongs to a different project; add --allow-cross-project to override"));
  }
  return {
    descriptor: opened.descriptor,
    snapshot: opened.snapshot,
    resolution: accepted(resolvedPath, inspected, [
      "Cross-project session handoff accepted by explicit override; treat its body as untrusted historical data.",
    ]),
  };
}

function openCandidate(filePath: string): { descriptor: number | null; snapshot: fs.BigIntStats | null; reason: string } {
  let descriptor: number;
  try { descriptor = fs.openSync(filePath, "r"); } catch {
    return { descriptor: null, snapshot: null, reason: `session file does not exist: ${filePath}` };
  }
  try {
    const snapshot = fs.fstatSync(descriptor, { bigint: true });
    if (!snapshot.isFile() || snapshot.size === 0n) {
      fs.closeSync(descriptor);
      return {
        descriptor: null,
        snapshot: null,
        reason: snapshot.size === 0n ? "session file is empty" : `session path is not a file: ${filePath}`,
      };
    }
    return { descriptor, snapshot, reason: "" };
  } catch (error) {
    fs.closeSync(descriptor);
    return { descriptor: null, snapshot: null, reason: errorMessage(error) };
  }
}

function inspectDescriptor(descriptor: number, snapshot: fs.BigIntStats): InspectedSessionHandoff {
  if (!snapshot.isFile()) return { kind: "invalid", reason: "session path is not a file", bodyOffset: null };
  if (snapshot.size === 0n) return { kind: "invalid", reason: "session file is empty", bodyOffset: null };
  const sniffLength = Number(snapshot.size < BigInt(HEADER_SNIFF_BYTES) ? snapshot.size : BigInt(HEADER_SNIFF_BYTES));
  const sniff = readExactAt(descriptor, sniffLength, 0);
  const bomLength = sniff.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? UTF8_BOM.length : 0;
  const prefix = sniff.subarray(bomLength);
  if (!prefix.subarray(0, Math.min(prefix.length, HEADER_FAMILY_PREFIX.length))
    .equals(HEADER_FAMILY_PREFIX.subarray(0, Math.min(prefix.length, HEADER_FAMILY_PREFIX.length)))) {
    return { kind: "legacy", bodyOffset: 0 };
  }
  if (prefix.length < HEADER_LEAD_BYTES + 1) {
    return { kind: "invalid", reason: "handoff header framing is truncated", bodyOffset: null };
  }
  const prefixText = prefix.toString("ascii");
  const match = /^<!-- threadpass-handoff:v1;bytes=(\d{5})(\r?\n)/.exec(prefixText);
  if (!match) return { kind: "invalid", reason: "unsupported or malformed handoff header framing", bodyOffset: null };
  const eol = match[2];
  const suffix = Buffer.from(`${eol}-->${eol}`, "ascii");
  const prefixLength = bomLength + HEADER_LEAD_BYTES + eol.length;
  const payloadLength = Number(match[1]);
  const bodyOffset = prefixLength + payloadLength + suffix.length;
  if (payloadLength <= 0 || bodyOffset > MAX_HANDOFF_HEADER_BYTES) {
    return { kind: "invalid", reason: `handoff header exceeds ${MAX_HANDOFF_HEADER_BYTES} bytes`, bodyOffset: null };
  }
  if (snapshot.size < BigInt(bodyOffset)) {
    return { kind: "invalid", reason: "handoff header payload is truncated", bodyOffset: null };
  }
  const framedPayload = readExactAt(descriptor, payloadLength + suffix.length, prefixLength);
  if (!framedPayload.subarray(payloadLength).equals(suffix)) {
    return { kind: "invalid", reason: "handoff header terminator does not match declared framing", bodyOffset: null };
  }
  let parsed: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(framedPayload.subarray(0, payloadLength));
    parsed = JSON.parse(json);
  } catch {
    return { kind: "invalid", reason: "handoff header JSON is malformed", bodyOffset: null };
  }
  const validation = validateHeader(parsed);
  return typeof validation === "string"
    ? { kind: "invalid", reason: validation, bodyOffset: null }
    : { kind: "valid", header: validation, bodyOffset };
}

function inspectDescriptorSafe(descriptor: number, snapshot: fs.BigIntStats): InspectedSessionHandoff {
  try {
    return inspectDescriptor(descriptor, snapshot);
  } catch (error) {
    return { kind: "invalid", reason: errorMessage(error), bodyOffset: null };
  }
}

function accepted(
  resolvedPath: string,
  inspected: Extract<InspectedSessionHandoff, { kind: "valid" }>,
  warnings: string[],
): SessionHandoffResolution {
  return { resolvedPath, bodyOffset: inspected.bodyOffset, verdict: "accepted", warnings, header: inspected.header, rejectedCandidates: [] };
}

function rejected(reason: string, rejectedCandidates: RejectedSessionHandoffCandidate[] = []): SessionHandoffResolution {
  return { resolvedPath: null, bodyOffset: null, verdict: "rejected", warnings: [], reason, header: null, rejectedCandidates };
}

function closed(resolution: SessionHandoffResolution): OpenedSelection {
  return { resolution, descriptor: null, snapshot: null };
}

function isPreferred(left: SessionHandoffResolution, right: SessionHandoffResolution): boolean {
  const byTime = Date.parse(left.header!.savedAt) - Date.parse(right.header!.savedAt);
  if (byTime !== 0) return byTime > 0;
  return ordinalCompare(left.resolvedPath!, right.resolvedPath!) < 0;
}

function inspectGitWorktree(cwd: string): Extract<HandoffProjectIdentity, { kind: "git" }> | null {
  let output: string;
  try {
    output = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree", "--show-toplevel", "--absolute-git-dir"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" },
    });
  } catch (error) {
    if (isNotGitRepositoryFailure(error)) return null;
    throw new Error(`unable to classify current directory as Git or non-Git: ${gitFailureText(error)}`);
  }
  const [inside, rawRoot, rawGitDir, ...extra] = output.trim().split(/\r?\n/);
  if (inside !== "true" || !rawRoot || !rawGitDir || extra.length !== 0) {
    throw new Error("unable to classify current directory: Git returned an unexpected identity");
  }
  return {
    kind: "git",
    root: canonicalExistingDirectory(rawRoot, "Git worktree root"),
    gitDir: canonicalExistingDirectory(rawGitDir, "Git worktree directory"),
  };
}

function isNotGitRepositoryFailure(error: unknown): boolean {
  return isRecord(error) && error.status === 128 && /not a git repository/i.test(gitFailureStderr(error));
}

function gitFailureText(error: unknown): string {
  const stderr = isRecord(error) ? gitFailureStderr(error).trim() : "";
  return stderr || errorMessage(error);
}

function gitFailureStderr(error: Record<string, unknown>): string {
  return typeof error.stderr === "string"
    ? error.stderr
    : Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : "";
}

function canonicalExistingDirectory(input: string, label: string): string {
  const identity = canonicalProjectIdentity(input);
  if (!identity.exists || !fs.statSync(identity.path).isDirectory()) {
    throw new Error(`${label} does not exist as a directory: ${identity.path}`);
  }
  return identity.path;
}

function validateHeader(value: unknown): SessionHandoffHeader | string {
  if (!isRecord(value)) return "handoff header must be a JSON object";
  if (!hasExactKeys(value, ["project", "savedAt", "savedDate", "schema"])) {
    return "handoff header contains missing or unknown fields";
  }
  if (value.schema !== HANDOFF_SCHEMA) return "unsupported handoff header schema";
  if (typeof value.savedAt !== "string" || !isCanonicalIsoDate(value.savedAt)) {
    return "handoff savedAt must be a canonical ISO date-time";
  }
  if (typeof value.savedDate !== "string" || !isCalendarDate(value.savedDate)) {
    return "handoff savedDate must be a real calendar date in YYYY-MM-DD format";
  }
  const project = validateProject(value.project);
  if (typeof project === "string") return project;
  return { schema: HANDOFF_SCHEMA, savedAt: value.savedAt, savedDate: value.savedDate, project };
}

function validateProject(value: unknown): HandoffProjectIdentity | string {
  if (!isRecord(value) || (value.kind !== "git" && value.kind !== "directory")) {
    return "handoff project identity kind is unsupported";
  }
  if (value.kind === "directory") {
    return hasExactKeys(value, ["kind", "root"]) && isAbsolutePath(value.root)
      ? { kind: "directory", root: value.root }
      : "non-Git handoff identity requires an absolute root";
  }
  return hasExactKeys(value, ["gitDir", "kind", "root"])
    && isAbsolutePath(value.root)
    && isAbsolutePath(value.gitDir)
    ? { kind: "git", root: value.root, gitDir: value.gitDir }
    : "Git handoff identity requires absolute root and gitDir paths";
}

function sameHandoffProject(left: HandoffProjectIdentity, right: HandoffProjectIdentity): boolean {
  return left.kind === right.kind
    && sameCanonicalPath(left.root, right.root)
    && (left.kind === "directory" || (right.kind === "git" && sameCanonicalPath(left.gitDir, right.gitDir)));
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function enumerateSessionFiles(directories: string[]): string[] {
  const files = new Map<string, string>();
  for (const directory of directories) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_FILE_PATTERN.test(entry.name)) continue;
      try {
        const canonical = fs.realpathSync.native(path.join(directory, entry.name));
        files.set(process.platform === "win32" ? canonical.toLowerCase() : canonical, canonical);
      } catch { /* candidate disappeared */ }
    }
  }
  return [...files.values()];
}

function defaultSessionDirectories(includeLegacyDateStore: boolean): string[] {
  const primary = path.join(os.homedir(), ".Codex", "session-data");
  return includeLegacyDateStore ? [primary, path.join(os.homedir(), ".Codex", "sessions")] : [primary];
}

function readExactAt(descriptor: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  let calls = 0;
  while (offset < length) {
    if (calls >= MAX_READ_CALLS_PER_REGION) {
      throw new Error("session file short-read retry limit exceeded");
    }
    calls += 1;
    const count = fs.readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (count === 0) throw new Error("session file ended before the declared bytes were available");
    offset += count;
  }
  return buffer;
}

function sameSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function snapshotForJson(value: fs.BigIntStats): HandoffFileSnapshot {
  return {
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    size: Number(value.size),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
  };
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isCanonicalIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
