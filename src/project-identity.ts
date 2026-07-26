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
 * Existing paths go through `realpath`, so junctions, symlinks, and filesystem
 * casing converge. Missing paths still receive absolute/path normalization. The
 * display path retains useful casing; `key` is the case-insensitive Windows key.
 */
export function canonicalProjectIdentity(input: string): ProjectIdentity {
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("project path must be a non-empty string");
  }

  let candidate = stripWindowsExtendedPrefix(input);
  if (process.platform === "win32") candidate = candidate.replaceAll("/", "\\");
  candidate = path.resolve(candidate);

  const exists = fs.existsSync(candidate);
  let canonical = exists ? fs.realpathSync.native(candidate) : candidate;
  canonical = stripWindowsExtendedPrefix(path.normalize(canonical));
  canonical = removeTrailingSeparators(canonical);

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

function removeTrailingSeparators(input: string): string {
  const root = path.parse(input).root;
  if (input === root) return input;
  const withoutTrailing = input.replace(/[\\/]+$/, "");
  return withoutTrailing === "" ? root : withoutTrailing;
}


