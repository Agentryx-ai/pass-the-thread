# Codex Desktop artifact provenance: 26.721.41059

This directory describes the local artifacts used for the `docs/research/codex-desktop/26.721.41059` snapshot. Binary artifacts are local evidence only and are excluded from Git by `.gitignore`.

## Version layers

| Layer | Value | Source |
| --- | --- | --- |
| Installed MSIX | `26.721.4979.0` | `AppxManifest.xml` and `Get-AppxPackage` |
| Package identity | `OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0` | Installed Windows package |
| Electron application | `26.721.41059` | packaged `app.asar` → `package.json` |
| Electron build number | `5848` | packaged `app.asar` → `package.json` |

The research directory is keyed by the internal Electron application version because the inspected JS behavior lives in `app.asar`.

## Local artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/app.asar` | 209,728,412 | `44884F86D619A12C3C0AF1B8C65945005BDA4379775B03270674C666226FF4B7` |
| `artifacts/codex.exe` | 353,628,464 | `39E9E041EA33AC34AAD9578ADFE660C5C7A6DC8F82620B77623960F9352A6EF3` |

Source paths:

```text
C:\Program Files\WindowsApps\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\app\resources\app.asar
C:\Program Files\WindowsApps\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\app\resources\codex.exe
```

The copied files matched their installed sources byte-for-byte by size and SHA-256 on 2026-07-26. The smaller `...\OpenAI.Codex_...\app\codex.exe` launcher is a different file and is not the app-server artifact described here.

## Evidence boundary

- `app.asar` was inspected statically. It establishes renderer strings, Electron main-process routing, request names, defaults, and timeouts.
- `codex.exe` is retained to pin the native app-server version and hash. No native decompilation result is claimed by this snapshot.
- Claude Code and Cursor import mapping is therefore unknown inside Rust beyond the static `externalAgentConfig/import` request boundary and runtime outputs.
- `app.asar.unpacked` was not copied. Full extraction can report missing unpacked native dependencies; those errors do not change the hashes above.

## Verification

```powershell
Get-FileHash -Algorithm SHA256 `
  .\reference\codex-desktop\26.721.41059\artifacts\app.asar, `
  .\reference\codex-desktop\26.721.41059\artifacts\codex.exe
```

Expected values are also recorded in `manifest.json`.
