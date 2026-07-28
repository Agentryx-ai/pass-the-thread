import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { stripWindowsExtendedPrefix } from "./project-identity.ts";

export const SUPPORTED_CODEX_TARGET = {
  internalVersion: "26.721.41059",
  appAsarSha256: "44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7",
  codexExeSha256: "39e9e041ea33ac34aad9578adfe660c5c7a6dc8f82620b77623960f9352a6ef3",
} as const;

export interface CodexTargetEvidence {
  internalVersion: string;
  appAsarSha256: string;
  codexExeSha256: string;
  containerVersion?: string;
  /** Live executable path, populated only by installed-artifact verification. */
  codexExePath?: string;
}

export const CODEX_PRIVATE_WRITE_CAPABILITIES = {
  rollout: "codex.rollout-jsonl/v26.721.41059",
  threadIndex: "codex.thread-index-sqlite/v26.721.41059",
  archive: "codex.archive-registration/v26.721.41059",
  projectIdentity: "codex.project-cwd-identity/v26.721.41059",
} as const;

export type CodexPrivateWriteCapability = keyof typeof CODEX_PRIVATE_WRITE_CAPABILITIES;

export interface CodexCapabilityBinding {
  id: string;
  fingerprint: string;
}

export interface CodexPrivateWriteProfile {
  schema: "pass-the-thread/codex-private-write-profile-v1";
  artifactFingerprint: string;
  structurallyVerified: boolean;
  capabilities: Record<CodexPrivateWriteCapability, CodexCapabilityBinding | null>;
}

function capabilityFingerprint(capability: CodexPrivateWriteCapability): string {
  return createHash("sha256").update(JSON.stringify({
    capability: CODEX_PRIVATE_WRITE_CAPABILITIES[capability],
    target: SUPPORTED_CODEX_TARGET,
  }), "utf8").digest("hex");
}

/**
 * Probe a private-write profile without rejecting unknown/new applications.
 * Read, scan, plan and dry-run callers retain the artifact fingerprint and see
 * null capabilities. Mutation callers must separately assert the capabilities
 * they need.
 */
export function probeCodexPrivateWriteProfile(evidence: CodexTargetEvidence): CodexPrivateWriteProfile {
  const artifactFingerprint = createHash("sha256").update(JSON.stringify({
    internalVersion: evidence.internalVersion,
    appAsarSha256: evidence.appAsarSha256.toLowerCase(),
    codexExeSha256: evidence.codexExeSha256.toLowerCase(),
    containerVersion: evidence.containerVersion ?? null,
  }), "utf8").digest("hex");
  const structurallyVerified = codexTargetVersionErrors(evidence).length === 0;
  const binding = (capability: CodexPrivateWriteCapability): CodexCapabilityBinding | null =>
    structurallyVerified
      ? { id: CODEX_PRIVATE_WRITE_CAPABILITIES[capability], fingerprint: capabilityFingerprint(capability) }
      : null;
  return {
    schema: "pass-the-thread/codex-private-write-profile-v1",
    artifactFingerprint,
    structurallyVerified,
    capabilities: {
      rollout: binding("rollout"),
      threadIndex: binding("threadIndex"),
      archive: binding("archive"),
      projectIdentity: binding("projectIdentity"),
    },
  };
}

export function assertCodexPrivateWriteCapabilities(
  evidence: CodexTargetEvidence,
  required: readonly CodexPrivateWriteCapability[],
): CodexPrivateWriteProfile {
  assertSupportedCodexTarget(evidence);
  const profile = probeCodexPrivateWriteProfile(evidence);
  const missing = required.filter((capability) => profile.capabilities[capability] == null);
  if (missing.length > 0) {
    throw new Error(`Codex private-write capability gate failed: ${missing.join(", ")}`);
  }
  return profile;
}

interface SnapshotArtifact {
  name?: unknown;
  source_path?: unknown;
  size_bytes?: unknown;
  sha256?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha256FileSync(filePath: string): string {
  const hash = createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

/**
 * Load the repository snapshot manifest and re-hash its installed source
 * artifacts. A copied manifest alone is not evidence of the live target.
 */
export function loadInstalledCodexTargetEvidence(manifestPath: string): CodexTargetEvidence {
  const manifest = record(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const electron = record(manifest?.electron_app);
  const installed = record(manifest?.installed_package);
  if (process.platform !== "win32") throw new Error("installed Codex package verification is Windows-only");
  const activeRaw = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 PackageFullName,InstallLocation,@{n='Version';e={$_.Version.ToString()}} | ConvertTo-Json -Compress",
  ], { encoding: "utf8" }).trim();
  const active = record(JSON.parse(activeRaw));
  if (
    typeof active?.PackageFullName !== "string" ||
    typeof active.InstallLocation !== "string" ||
    typeof active.Version !== "string"
  ) throw new Error("cannot resolve the active OpenAI.Codex Appx package");
  const canonical = (value: string): string =>
    path.resolve(stripWindowsExtendedPrefix(value)).toLowerCase();
  if (
    installed?.package_full_name !== active.PackageFullName ||
    installed.msix_version !== active.Version ||
    typeof installed.install_location !== "string" ||
    canonical(installed.install_location) !== canonical(active.InstallLocation)
  ) throw new Error("Codex evidence manifest does not describe the active installed package");
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts as SnapshotArtifact[] : [];
  const find = (name: string): SnapshotArtifact => {
    const artifact = artifacts.find((candidate) => candidate?.name === name);
    if (!artifact || typeof artifact.source_path !== "string" || typeof artifact.sha256 !== "string") {
      throw new Error(`Codex evidence manifest has no usable ${name} source artifact`);
    }
    const livePath = path.join(active.InstallLocation as string, "app", "resources", name);
    if (canonical(artifact.source_path) !== canonical(livePath)) {
      throw new Error(`Codex evidence ${name} path is not inside the active package`);
    }
    if (!fs.existsSync(livePath)) {
      throw new Error(`installed Codex artifact is missing: ${livePath}`);
    }
    const stat = fs.statSync(livePath);
    if (typeof artifact.size_bytes === "number" && stat.size !== artifact.size_bytes) {
      throw new Error(`installed Codex artifact size changed: ${livePath}`);
    }
    const actual = sha256FileSync(livePath);
    if (!sameHash(actual, artifact.sha256)) {
      throw new Error(`installed Codex artifact hash changed: ${livePath}`);
    }
    return artifact;
  };
  const appAsar = find("app.asar");
  const codexExe = find("codex.exe");
  if (typeof electron?.version !== "string") {
    throw new Error("Codex evidence manifest has no Electron application version");
  }
  const evidence: CodexTargetEvidence = {
    internalVersion: electron.version,
    appAsarSha256: String(appAsar.sha256),
    codexExeSha256: String(codexExe.sha256),
    codexExePath: path.join(active.InstallLocation as string, "app", "resources", "codex.exe"),
  };
  if (typeof installed?.msix_version === "string") evidence.containerVersion = installed.msix_version;
  return evidence;
}

function sameHash(actual: string, expected: string): boolean {
  const a = Buffer.from(actual.trim().toLowerCase(), "utf8");
  const b = Buffer.from(expected.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function codexTargetVersionErrors(evidence: CodexTargetEvidence): string[] {
  const errors: string[] = [];
  if (evidence.internalVersion !== SUPPORTED_CODEX_TARGET.internalVersion) {
    errors.push(
      `unsupported Codex bundle ${evidence.internalVersion}; expected ${SUPPORTED_CODEX_TARGET.internalVersion}`,
    );
  }
  if (!sameHash(evidence.appAsarSha256, SUPPORTED_CODEX_TARGET.appAsarSha256)) {
    errors.push("Codex app.asar hash does not match the audited bundle");
  }
  if (!sameHash(evidence.codexExeSha256, SUPPORTED_CODEX_TARGET.codexExeSha256)) {
    errors.push("Codex executable hash does not match the audited bundle");
  }
  return errors;
}

export function assertSupportedCodexTarget(evidence: CodexTargetEvidence): void {
  const errors = codexTargetVersionErrors(evidence);
  if (errors.length) throw new Error(`Codex target version gate failed: ${errors.join("; ")}`);
}
