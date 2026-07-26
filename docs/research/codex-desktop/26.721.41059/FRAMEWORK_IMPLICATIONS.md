# Implications for a unified importer framework

## Why an inspectable importer path is still needed

Codex Desktop's built-in importer is valuable for onboarding, but its contract is intentionally coarse: detect local agent data, choose broad categories, and report whether writes completed. The 50-session observation shows that this is not enough for a migration tool whose contract includes fidelity, predictability, and safe continuation.

The required path must be independently inspectable because:

- proprietary desktop formats and versioned native behavior can change without notice;
- an item-level success result does not describe representational loss;
- coarse aggregate selection cannot express project, archive, date, or per-session intent;
- token and compaction bookkeeping can make an apparently imported thread impossible to resume;
- users need a dry run and deterministic loss report before target files are changed.

## Architectural lineage

The canonical starting point was the predecessor `codex-to-claude` architecture, not Baton. Its useful separation of concerns is:

```text
versioned source reader
  -> normalized conversation representation
  -> explicit selection and project identity
  -> target writer
  -> structural validation and loss report
  -> operation journal / recovery
```

That architecture is evolving into Pass the Thread, an extensible framework that can host additional source/target adapters and import directions. This version-pinned research still documents evidence and design lineage, not a claim that every direction is complete.

## Minimum acceptance criteria for a new direction

1. **Pinned provenance:** record source/target application versions and hashes.
2. **Explicit selection:** preview exact sessions, projects, archive state, and date bounds before writing.
3. **Typed fidelity:** preserve native messages, calls, results, images, reasoning policy, compaction boundaries, and turn context where the target supports them.
4. **Declared loss:** emit a per-session loss report for every unsupported or flattened structure.
5. **Resumability:** validate context-window and compaction invariants before declaring success.
6. **Safe writes:** dry run by default for exploratory use, idempotent identity, collision checks, and a recoverable operation journal.
7. **Version gate:** refuse unknown format versions unless the user explicitly accepts an experimental path.
8. **Canonical source vs. target rendering:** never rewrite the source; keep its byte-exact revision in a sidecar, and make target rendering an explicit `semantic` (default) or `verbatim` choice in the confirmed plan.

The research in this snapshot informs these criteria; it does not itself prove that an implementation satisfies them.
