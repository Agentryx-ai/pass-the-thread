# Built-in importer surface

## Confirmed flow

The Electron bundle identifies the feature as External Agent Import and contains provider IDs for `claude-code`, `claude-cowork`, and `cursor`.

```text
renderer detection and selection
  -> Electron IPC: external-agent-import-detect
  -> provider-specific detection
  -> Electron IPC: external-agent-import-import
  -> Claude Code / Cursor: app-server RPC externalAgentConfig/import
  -> notification: externalAgentConfig/import/completed
```

The Electron main process waits up to 120 seconds for the completion notification. For Claude Code and Cursor, the request includes `migrationItems`, `providerId`, and `source: "app"`. This routing is `STATIC`. What `codex.exe` does with those items is `UNKNOWN` except where target files or runtime errors make the result observable.

## Visible choices and defaults

| Surface | Confirmed behavior | Evidence |
| --- | --- | --- |
| Providers | Claude Code, Claude Cowork, Cursor are represented in the bundle. Standard Claude Chat is explicitly unsupported. | `STATIC` |
| Top-level choices | `Tools & setup`, `Projects ({count})`, and `Chat sessions ({count})` are separate checkboxes. | `STATIC`, `RUNTIME` |
| Tools & setup | Described as settings, instructions, plugins, and skills. Static item types also include commands, hooks, MCP server config, and agents where detected. | `STATIC` |
| Projects | Described as using existing project folders. | `STATIC` |
| Chats | Described as recent chats and represented by one aggregate choice. | `STATIC`, `RUNTIME` |
| Session defaults | `maxSessionAgeMs` defaults to `2,592,000,000` ms (30 days) and `maxSessions` defaults to 50 in the packaged migration code. | `STATIC` |
| Source safety | UI states that the existing source-app setup is not affected. | `STATIC` |

Remote configuration can override limits, and provider-specific enforcement in the Rust app-server is not visible. The batch stopping at exactly 50 sessions is consistent with the static default, but does not independently prove the Rust algorithm.

## Selection limitations observed in 26.721.41059

The import UI does not expose:

- a per-session selector;
- chat search;
- a user-selected date range;
- an active-versus-archived filter;
- an "existing Codex projects only" constraint.

The Projects and Chat sessions controls are independent. Checking or unchecking Projects changes project import items; it does not filter the aggregate chat set. This matters because "import projects" can reasonably be read as "only bring chats belonging to those projects," but that is not the implemented selection relationship.

The import ledger did not preserve a source archive-state field, so archive preservation cannot be reconstructed from the target. The visible UI also offers no archive-state choice.

## Risks for an importer framework

1. **Category selection is not transcript selection.** A Projects checkbox must not silently stand in for a project-based chat filter.
2. **A cap is not a review surface.** "Recent, maximum 50" is useful for onboarding, but insufficient for controlled migration.
3. **Completion is not fidelity.** The built-in result reports item-level success even when target-native structures are absent.
4. **Opaque native mapping needs output validation.** Static JS can establish the request boundary, not the Rust transformation rules.
