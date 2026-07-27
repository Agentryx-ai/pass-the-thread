import {
  createSessionHandoffHeader,
  readSessionHandoff,
  resolveSessionHandoff,
  type SessionHandoffResolution,
} from "./session-handoff.ts";

export const HANDOFF_HELP = `threadpass handoff — create, select, and read inert session handoffs

USAGE
  threadpass handoff header [--cwd <directory>] [--saved-at <ISO-date-time>]
  threadpass handoff resolve [<YYYY-MM-DD>|<file>] [--cwd <directory>]
                             [--file <file>] [--date <YYYY-MM-DD>]
                             [--allow-cross-project]
  threadpass handoff read    [<YYYY-MM-DD>|<file>] [--cwd <directory>]
                             [--file <file>] [--date <YYYY-MM-DD>]
                             [--allow-cross-project]

Resolve reads only framed header bytes. Read accepts first, then reads the body from the same descriptor.
`;

export function runSessionHandoffCommand(argv: string[]): number {
  const subcommand = argv[0];
  if (!subcommand) {
    process.stderr.write(HANDOFF_HELP);
    return writeFailure("handoff requires a subcommand: header, resolve, or read");
  }
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(HANDOFF_HELP);
    return 0;
  }

  try {
    if (subcommand === "header") return runHeader(argv.slice(1));
    if (subcommand === "resolve" || subcommand === "read") {
      return runResolveOrRead(argv.slice(1), subcommand);
    }
    return writeFailure(`unknown handoff command: ${subcommand}`);
  } catch (error) {
    return writeFailure(error instanceof Error ? error.message : String(error));
  }
}

function runHeader(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HANDOFF_HELP);
    return 0;
  }
  let cwd: string | undefined;
  let savedAt: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") cwd = requireValue(argv, ++index, arg);
    else if (arg === "--saved-at") savedAt = requireValue(argv, ++index, arg);
    else throw new Error(`unknown handoff header option: ${arg}`);
  }
  process.stdout.write(createSessionHandoffHeader({ cwd, savedAt }));
  return 0;
}

function runResolveOrRead(argv: string[], command: "resolve" | "read"): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HANDOFF_HELP);
    return 0;
  }
  let cwd: string | undefined;
  let explicitFile: string | undefined;
  let date: string | undefined;
  let allowCrossProject = false;
  let positional: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") cwd = requireValue(argv, ++index, arg);
    else if (arg === "--file") explicitFile = requireValue(argv, ++index, arg);
    else if (arg === "--date") date = requireValue(argv, ++index, arg);
    else if (arg === "--allow-cross-project") allowCrossProject = true;
    else if (arg.startsWith("-")) throw new Error(`unknown handoff ${command} option: ${arg}`);
    else if (positional === undefined) positional = arg;
    else throw new Error(`handoff ${command} accepts at most one date or file argument`);
  }
  if (positional !== undefined) {
    if (explicitFile !== undefined || date !== undefined) {
      throw new Error("do not combine a positional selector with --file or --date");
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(positional)) date = positional;
    else explicitFile = positional;
  }

  const options = {
    cwd,
    explicitFile,
    date,
    allowCrossProject,
  };
  const result = command === "read" ? readSessionHandoff(options) : resolveSessionHandoff(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.verdict === "accepted" ? 0 : 1;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function writeFailure(reason: string): number {
  const result: SessionHandoffResolution = {
    resolvedPath: null,
    bodyOffset: null,
    verdict: "rejected",
    warnings: [],
    reason,
    header: null,
    rejectedCandidates: [],
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 1;
}
