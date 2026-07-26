import { test } from "node:test";
import assert from "node:assert/strict";

import { npmSwallowedFlags, npmSwallowedMessage } from "../src/npm-flags.ts";

// `npm run import -- --dry-run` exports npm_config_dry_run and passes an empty
// argv, so the flag has to be recovered from the environment. Verified against
// npm 10: {"dry":"true","force":"true","argv":[]}.
test("a flag npm consumed is reported", () => {
  assert.deepEqual(npmSwallowedFlags(["import"], { npm_config_dry_run: "true" }), [
    "--dry-run",
  ]);
  assert.deepEqual(
    npmSwallowedFlags(["import"], {
      npm_config_dry_run: "true",
      npm_config_force: "true",
    }),
    ["--dry-run", "--force"],
  );
});

test("nothing is reported for a plain run", () => {
  assert.deepEqual(npmSwallowedFlags(["import"], {}), []);
  assert.deepEqual(npmSwallowedFlags(["import", "--dry-run"], {}), []);
});

test("an .npmrc setting is not mistaken for a swallowed flag", () => {
  // The flag did arrive, so there is nothing to refuse — running is what the
  // user asked for either way.
  assert.deepEqual(
    npmSwallowedFlags(["import", "--dry-run"], { npm_config_dry_run: "true" }),
    [],
  );
  assert.deepEqual(
    npmSwallowedFlags(["import", "--dry-run", "--force"], {
      npm_config_dry_run: "true",
      npm_config_force: "true",
    }),
    [],
  );
});

test("only a literal true counts", () => {
  assert.deepEqual(npmSwallowedFlags(["import"], { npm_config_dry_run: "false" }), []);
  assert.deepEqual(npmSwallowedFlags(["import"], { npm_config_dry_run: "" }), []);
});

test("the message names the flag and a command that works", () => {
  const msg = npmSwallowedMessage(["--dry-run"], ["import"]);
  assert.match(msg, /--dry-run never reached this tool/);
  assert.match(msg, /src\/threadpass\.ts import --dry-run/);
});
