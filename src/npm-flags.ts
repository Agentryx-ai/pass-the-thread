// Flags npm claims for itself.
//
// `npm run import -- --dry-run` never reaches this tool: npm parses the flag as
// its own config, exports `npm_config_dry_run=true` and passes an empty argv on.
// A dry run that silently writes for real is the worst outcome this tool has, so
// it refuses rather than guessing what was meant.
//
// Honoring the env var instead would be worse than the bug for `--force`: a
// stale `force=true` in someone's .npmrc would turn a plain run into a forced
// overwrite of transcripts they had continued in Claude.
const NPM_OWNED_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ["npm_config_dry_run", "--dry-run"],
  ["npm_config_force", "--force"],
];

/**
 * Flags npm consumed on this invocation. The env var is evidence of a
 * *swallowed* flag only when the flag is absent from argv — otherwise it came
 * from an .npmrc and the flag was passed properly anyway.
 */
export function npmSwallowedFlags(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return NPM_OWNED_FLAGS.filter(
    ([key, flag]) => env[key] === "true" && !argv.includes(flag),
  ).map(([, flag]) => flag);
}

/** What to tell the user, given the flags npm ate. */
export function npmSwallowedMessage(swallowed: readonly string[], argv: readonly string[]): string {
  const args = [...argv, ...swallowed].join(" ");
  return (
    `ERROR: ${swallowed.join(" and ")} never reached this tool.\n` +
    `npm has flags of the same name and consumed them, so this would have run for\n` +
    `real. Run it directly instead:\n\n` +
    `  node --experimental-strip-types --experimental-sqlite src/threadpass.ts ${args}\n\n` +
    `or use a script with the flag already in it:  npm run import:dry\n`
  );
}
