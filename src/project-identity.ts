import fs from "node:fs";
import path from "node:path";

export interface ProjectIdentity {
  /** Absolute, normalized path, using the spelling reported by the filesystem when it exists. */
  path: string;
  /** Windows comparison key. Project paths are case-insensitive. */
  key: string;
  /** Whether the path existed when the identity was built. */
  exists: boolean;
}

/** Remove Win32's extended-length marker without changing the path it denotes. */
export function stripWindowsExtendedPrefix(input: string): string {
  if (/^\\\\\?\\UNC\\/i.test(input)) return `\\\\${input.slice(8)}`;
  if (/^\\\\\?\\/.test(input)) return input.slice(4);
  if (/^\/\/\?\/UNC\//i.test(input)) return `//${input.slice(8)}`;
  if (/^\/\/\?\//.test(input)) return input.slice(4);
  return input;
}

/**
 * Build the identity used everywhere source and target projects are compared.
 *
 * Existing host-native paths go through `realpath`, so junctions, symlinks, and
 * filesystem casing converge. Missing and foreign-platform paths still receive
 * absolute/path normalization. The display path retains useful casing; `key` is
 * the case-insensitive Windows key.
 */
export function canonicalProjectIdentity(input: string): ProjectIdentity {
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("project path must be a non-empty string");
  }

  let candidate = stripWindowsExtendedPrefix(input);
  const usesWindowsPaths = isWindowsAbsolutePath(input, candidate);
  const pathApi = usesWindowsPaths ? path.win32 : path;
  if (usesWindowsPaths) candidate = candidate.replaceAll("/", "\\");
  candidate = pathApi.resolve(candidate);

  const exists = (!usesWindowsPaths || process.platform === "win32") && fs.existsSync(candidate);
  let canonical = exists ? fs.realpathSync.native(candidate) : candidate;
  canonical = stripWindowsExtendedPrefix(pathApi.normalize(canonical));
  canonical = removeTrailingSeparators(canonical, pathApi);

  return { path: canonical, key: canonical.toLowerCase(), exists };
}

export function sameProject(
  left: string | ProjectIdentity,
  right: string | ProjectIdentity,
): boolean {
  const leftIdentity = typeof left === "string" ? canonicalProjectIdentity(left) : left;
  const rightIdentity = typeof right === "string" ? canonicalProjectIdentity(right) : right;
  return leftIdentity.key === rightIdentity.key;
}

function isWindowsAbsolutePath(input: string, withoutExtendedPrefix: string): boolean {
  if (process.platform === "win32"
    || /^\\\\\?\\|^\/\/\?\//.test(input)
    || /^[a-z]:[\\/]/i.test(withoutExtendedPrefix)
    || withoutExtendedPrefix.startsWith("\\\\")) {
    return true;
  }

  if (!/^\/\/[^/\\]+\/[^/\\]+(?:[\\/]|$)/.test(withoutExtendedPrefix)) return false;

  // POSIX permits implementation-defined meaning for exactly two leading
  // slashes. Preserve an existing host path; when it is absent, there is no
  // lexical distinction, so prefer cross-host comparison as a Windows UNC path.
  return !fs.existsSync(withoutExtendedPrefix);
}

function removeTrailingSeparators(input: string, pathApi: typeof path.win32): string {
  const root = pathApi.parse(input).root;
  if (input === root) return input;
  const withoutTrailing = input.replace(/[\\/]+$/, "");
  return withoutTrailing === "" ? root : withoutTrailing;
}


