import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(
  command: string,
  args: string[],
  cwd: string,
  shell = process.platform === "win32",
) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
}

test("packed package installs and both published bins run", { timeout: 60_000 }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pass-the-thread-package-"));
  const packDir = path.join(tempRoot, "pack");
  const consumerDir = path.join(tempRoot, "consumer");
  fs.mkdirSync(packDir);
  fs.mkdirSync(consumerDir);
  fs.writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "pass-the-thread-smoke-consumer", private: true }),
  );

  try {
    const packed = run(npm, ["pack", "--json", "--pack-destination", packDir], root);
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const result = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    assert.equal(result.length, 1);
    const tarball = path.join(packDir, result[0].filename);
    assert.equal(fs.existsSync(tarball), true, `missing tarball: ${tarball}`);

    const installed = run(
      npm,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball],
      consumerDir,
    );
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    for (const name of ["threadpass", "codex-to-claude"]) {
      const suffix = process.platform === "win32" ? ".cmd" : "";
      const bin = path.join(consumerDir, "node_modules", ".bin", `${name}${suffix}`);
      assert.equal(fs.existsSync(bin), true, `missing installed bin: ${bin}`);
      const help = run(bin, ["--help"], consumerDir, process.platform === "win32");
      assert.equal(help.status, 0, `${name}: ${help.stderr || help.stdout}`);
      assert.match(help.stdout, /Pass the Thread/);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
