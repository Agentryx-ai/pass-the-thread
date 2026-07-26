#!/usr/bin/env -S node --experimental-sqlite
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main as runLegacyCommand } from "./cli.ts";
import { formatCliError, main as runMatrixCommand } from "./matrix-cli.ts";

const LEGACY_COMMANDS = new Set(["list", "import", "fix"]);
const MATRIX_COMMANDS = new Set(["scan", "plan", "apply", "recover"]);

export const HELP = `Pass the Thread — move agent sessions without losing their structure

USAGE
  threadpass <command> [options]

COMMANDS
  list      list Codex sessions available for legacy Codex → Claude import
  import    import selected Codex sessions into Claude
  fix       repair legacy Codex → Claude imports
  scan      inventory sessions for the provider matrix
  plan      build a deterministic provider-matrix import plan
  apply     apply a confirmed provider-matrix plan
  recover   recover an interrupted provider-matrix operation

Run threadpass <command> --help for command-specific options.
The codex-to-claude executable remains available as a compatibility alias.
`;

export function dispatch(argv: string[]): number {
  const command = argv[0];
  if (!command || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
  if (LEGACY_COMMANDS.has(command)) {
    return argv.includes("--help") || argv.includes("-h")
      ? runLegacyCommand(["--help"])
      : runLegacyCommand(argv);
  }
  if (MATRIX_COMMANDS.has(command)) {
    runMatrixCommand(argv);
    return 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

if (
  process.argv[1] &&
  fs.realpathSync.native(fileURLToPath(import.meta.url)) ===
    fs.realpathSync.native(path.resolve(process.argv[1]))
) {
  try {
    process.exitCode = dispatch(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
