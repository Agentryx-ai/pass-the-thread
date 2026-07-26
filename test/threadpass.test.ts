import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(root, "src", "threadpass.ts");
const nodeArgs = ["--experimental-strip-types", "--experimental-sqlite", entrypoint];

function run(...args: string[]) {
  return spawnSync(process.execPath, [...nodeArgs, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_dry_run: "false", npm_config_force: "false" },
  });
}

test("canonical wrapper exposes legacy and matrix command help", () => {
  const top = run("--help");
  assert.equal(top.status, 0, top.stderr);
  assert.match(top.stdout, /Pass the Thread/);
  assert.match(top.stdout, /list/);
  assert.match(top.stdout, /scan/);

  const legacy = run("list", "--help");
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /threadpass list/);

  const matrix = run("scan", "--help");
  assert.equal(matrix.status, 0, matrix.stderr);
  assert.match(matrix.stdout, /threadpass <scan\|plan\|apply\|recover>/);
});

test("package metadata publishes threadpass and keeps the legacy bin alias", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    name: string;
    repository: { url: string };
    bin: Record<string, string>;
  };
  assert.equal(pkg.name, "pass-the-thread");
  assert.equal(pkg.repository.url, "git+https://github.com/Agentryx-ai/pass-the-thread.git");
  assert.deepEqual(pkg.bin, {
    threadpass: "dist/threadpass.js",
    "codex-to-claude": "dist/threadpass.js",
  });
});
