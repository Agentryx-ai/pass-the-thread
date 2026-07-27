import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = [
  process.env.npm_execpath,
  process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js") : undefined,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
].find((candidate): candidate is string => typeof candidate === "string" && fs.existsSync(candidate));
if (npmCli === undefined) throw new Error("npm CLI JavaScript entrypoint is unavailable");
const npmCliPath = npmCli;
const exactTextEntries = [
  "package/LICENSE",
  "package/NOTICE",
  "package/package.json",
  "package/README.md",
  "package/dist/cli.js",
  "package/dist/codex-target-db.js",
  "package/dist/codex-target.js",
  "package/dist/map.js",
  "package/dist/threadpass.js",
  "package/docs/CLI.md",
  "package/docs/CONVERSION.md",
  "package/docs/FORMATS.md",
  "package/docs/research/codex-desktop/26.721.41059/BATCH_OBSERVATIONS.md",
  "package/docs/research/codex-desktop/26.721.41059/BUILT_IN_IMPORTER.md",
  "package/docs/research/codex-desktop/26.721.41059/COMPACTION_CASE.md",
  "package/docs/research/codex-desktop/26.721.41059/FRAMEWORK_IMPLICATIONS.md",
  "package/docs/research/codex-desktop/26.721.41059/PROJECT_GROUPING_CASE.md",
  "package/docs/research/codex-desktop/26.721.41059/README.md",
  "package/docs/research/codex-desktop/26.721.41059/RESUME_CONTAMINATION_CASE.md",
  "package/reference/codex-desktop/26.721.41059/manifest.json",
  "package/reference/codex-desktop/26.721.41059/README.md",
] as const;

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function copyPackageInputs(destination: string): void {
  for (const directory of ["src", "docs", "reference"]) {
    fs.cpSync(path.join(repoRoot, directory), path.join(destination, directory), { recursive: true });
  }
  for (const file of [
    ".gitignore",
    ".gitattributes",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "README.md",
    "LICENSE",
    "NOTICE",
  ]) {
    const source = path.join(repoRoot, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, file));
  }
}

function commitFixture(sourceRoot: string): void {
  run("git", ["init", "--initial-branch", "main"], sourceRoot);
  run("git", ["config", "core.autocrlf", "true"], sourceRoot);
  run("git", ["config", "user.name", "Threadpass Test"], sourceRoot);
  run("git", ["config", "user.email", "threadpass@example.invalid"], sourceRoot);
  run("git", ["add", "--all"], sourceRoot);
  const fixed = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  run("git", ["commit", "-m", "fixture"], sourceRoot, fixed);
}

function buildAndPack(checkout: string, root: string, name: string): Buffer {
  fs.symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(checkout, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [tsc, "-p", "tsconfig.build.json"], checkout);
  const destination = path.join(root, `${name}-pack`);
  fs.mkdirSync(destination);
  run(process.execPath, [npmCliPath, "pack", "--pack-destination", destination], checkout);
  const tarballs = fs.readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
  assert.deepEqual(tarballs, ["pass-the-thread-0.1.0.tgz"]);
  const tarball = tarballs[0];
  assert.ok(tarball);
  return fs.readFileSync(path.join(destination, tarball));
}

function cloneBuildAndPack(sourceRoot: string, root: string, name: string, autocrlf: "true" | "false" | "input"): Buffer {
  const checkout = path.join(root, name);
  run("git", ["-c", `core.autocrlf=${autocrlf}`, "clone", "--no-local", sourceRoot, checkout], root);
  return buildAndPack(checkout, root, name);
}

function tarEntries(tarball: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tarball);
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start: number, length: number) => header.subarray(start, start + length)
      .toString("utf8").replace(/\0.*$/s, "");
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readString(124, 12).trim() || "0", 8);
    const bodyStart = offset + 512;
    entries.set(fullName, tar.subarray(bodyStart, bodyStart + size));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("npm pack is byte-identical across fresh Windows checkout line-ending modes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "threadpass-package-repro-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);
  copyPackageInputs(sourceRoot);
  commitFixture(sourceRoot);

  // The authoritative tarball must come from a checkout too: sourceRoot holds the contributor's
  // raw worktree bytes, which still carry CRLF on a checkout that predates .gitattributes.
  const authoritativeTarball = cloneBuildAndPack(sourceRoot, root, "authoritative", "input");
  const lfTarball = cloneBuildAndPack(sourceRoot, root, "checkout-lf", "false");
  const crlfTarball = cloneBuildAndPack(sourceRoot, root, "checkout-crlf", "true");
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const authoritativeEntries = tarEntries(authoritativeTarball);
  const lfEntries = tarEntries(lfTarball);
  const crlfEntries = tarEntries(crlfTarball);
  const countHint = "packaged entry count changed: give the new file a `text eol=lf` line in .gitattributes before updating this count. A new src file counts too, because it emits a new dist entry and CR survives inside multi-line template literals.";
  assert.equal(authoritativeEntries.size, 61, countHint);
  assert.equal(lfEntries.size, 61, countHint);
  assert.equal(crlfEntries.size, 61, countHint);
  const differingEntries = (left: Map<string, Buffer>, right: Map<string, Buffer>) => [
    ...new Set([...left.keys(), ...right.keys()]),
  ]
    .filter((entry) => {
      const leftBytes = left.get(entry);
      const rightBytes = right.get(entry);
      return leftBytes === undefined || rightBytes === undefined || !leftBytes.equals(rightBytes);
    })
    .sort();
  const hashes = `authoritative=${sha256(authoritativeTarball)} lf=${sha256(lfTarball)} crlf=${sha256(crlfTarball)}`;
  const authoritativeCheckoutDifferences = differingEntries(authoritativeEntries, crlfEntries);
  assert.deepEqual(
    authoritativeCheckoutDifferences,
    [],
    `authoritative and CRLF-checkout entry hashes differ: ${hashes} entries=${authoritativeCheckoutDifferences.join(",")}`,
  );
  assert.equal(
    Buffer.compare(authoritativeTarball, crlfTarball),
    0,
    `authoritative and CRLF-checkout raw tarballs differ: ${hashes}`,
  );
  const checkoutDifferences = differingEntries(lfEntries, crlfEntries);
  assert.deepEqual(
    checkoutDifferences,
    [],
    `LF and CRLF checkout entry hashes differ: ${hashes} entries=${checkoutDifferences.join(",")}`,
  );
  assert.equal(
    Buffer.compare(crlfTarball, lfTarball),
    0,
    `LF and CRLF checkout raw tarballs differ: ${hashes}`,
  );

  const entries = lfEntries;
  for (const entry of exactTextEntries) {
    const bytes = entries.get(entry);
    assert.ok(bytes, `missing tar entry: ${entry}`);
    assert.equal(bytes.includes(Buffer.from("\r\n")), false, `CRLF remained in ${entry}`);
  }
});
