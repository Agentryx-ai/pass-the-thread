# Duplicate project grouping case

## Evidence limit

Two same-name/same-looking project entries were observed after import, but the empty pre-import entry has since been archived or removed. The exact pair can no longer be compared, so a single historical root cause is `UNKNOWN`.

The 26.721.41059 Electron code nevertheless exposes a credible duplicate path. Project records carry `rootPaths`; the relevant update/dedup surface compares path arrays as stored, while path handling uses lexical resolution/stat checks rather than a filesystem `realpath` identity. This is `STATIC` evidence for susceptibility, not proof of which spelling created the deleted duplicate.

## Spellings that can name the same Windows directory

- `C:\repo` versus `\\?\C:\repo`;
- drive-letter or component case differences;
- slash-direction and trailing-separator differences;
- 8.3 short names versus long names;
- junction, symlink, or `subst` aliases.

An exact string/array comparison can treat these as different even when Windows opens the same directory. Imported target rows in the observed batch also used extended-prefix/case spellings, so this is not merely theoretical. Whether the native importer itself created the second project record, or exposed an already distinct record, remains `UNKNOWN` without the deleted pair or a controlled reproduction.

## Framework mitigation

The shared `canonicalProjectIdentity` implementation:

1. strips extended Windows prefixes without changing the target;
2. resolves lexical path components;
3. uses `realpath.native` when the directory exists;
4. normalizes separators and case for comparison;
5. selects the longest existing target root;
6. does not create Codex project records during conversation import.

Consequently, the Claude → Codex adapter can attach a conversation to an existing canonical root or leave it in Recents; it does not create a second project entry as a side effect. A controlled native-UI reproduction is still needed to turn the historical hypothesis into a confirmed Codex Desktop defect.
