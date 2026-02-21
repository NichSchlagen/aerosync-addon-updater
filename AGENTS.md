# AGENTS.md

## Purpose and Scope
These instructions apply to coding agents working in the `aerosync-addon-updater` repository.
The goal is to keep coding-agent changes safe, consistent, and free of functional regressions.

## Project Overview (Short)
- Electron desktop app for updating X-Plane add-ons through multiple update providers (X-Updater and iniBuilds).
- Multi-profile management (each profile has its own product directory, channel, snapshot baseline, ignore list, and credentials).
- Provider routing: each profile has a `provider` field (`xupdater` or `inibuilds`); `main.js` dispatches `updates:check`/`updates:install` to the matching client via `getUpdateProvider()` (with host-based fallback for iniBuilds domains).
- Core flow:
  - Create update plan (`updates:check`)
  - Cache plan in memory
  - Install plan (`updates:install`) with checksum validation and optional gunzip fallback
- X-Updater flow: per-file downloads, MD5 checksum + gunzip fallback.
- iniBuilds flow: Shopify auth → token exchange → `filesUrl` API → full-ZIP download, package-level MD5 verification, per-file ZIP CRC32 extraction and validation.

## Tech Stack and Runtime
- Language: JavaScript (CommonJS), no TypeScript.
- Runtime: Node.js 20+, Electron 40.
- Build: `electron-builder`.
- No automated test suite currently exists in this repository.

## Coding-Agent Reality
- Coding agents can run command-line checks and static validation.
- Coding agents usually cannot perform trustworthy interactive desktop UI smoke tests.
- Never claim manual UI checks were executed unless explicitly confirmed by a human.
- If a manual check is required, mark it as `not run` and state why.

## Important Directories and Files
- `main.js`: main process, IPC handlers, native menu state, app-update check, provider routing.
- `preload.js`: secure bridge (`window.aeroApi`) between renderer and main.
- `src/renderer.js`: complete UI state, user flows, i18n application, check/install logic.
- `src/index.html`, `src/styles.css`: UI structure and styling.
- `lib/update-client.js`: X-Updater engine (auth, product/snapshot selection, plan creation, install, checksums).
- `lib/inibuilds-client.js`: iniBuilds engine (Shopify auth, product discovery, ZIP central directory parsing, per-file CRC32 install, manifest persistence, rollback snapshots).
- `lib/profile-store.js`: profile persistence, optional encrypted credentials.
- `lib/language-store.js`: external language loading and validation.
- `lib/atomic-file.js`: atomic file-write utility (temp+rename pattern); used for manifest/snapshot JSON persistence.
- `lib/safe-json.js`: safe JSON parsing (`parseJsonSafe`) without throwing.
- `lib/logger.js`: structured logger with auto-redaction of sensitive keys.
- `languages/en.json`, `languages/de.json`: UI strings.
- `.github/workflows/build-packages.yml`: release builds and artifact upload.
- `docs/`: end-user and contributor documentation.
- `docs/inibuilds-renderer-api-analysis.md`: reverse-engineering notes on the iniBuilds/iniManager API (reference doc).

## Architecture Invariants (Do Not Break)
1. `fresh` and `repair` are mutually exclusive.
2. In `repair`, `since` must always be `0` and `fresh` must be `false`.
3. An install plan is bound to `profileId`; installing with a different profile must fail.
4. Only one active installation is allowed at a time (`activeInstall` in `main.js`).
5. Pause/resume/cancel must only work for the same IPC sender that started the install.
6. All server file paths must be normalized and checked for traversal (`normalizeRelPath` and root boundary checks).
7. Installation order must remain: all `delete` actions first, then all `update` actions.
8. File integrity for X-Updater is MD5-based; on raw mismatch, gunzip hash fallback is required. For iniBuilds, package integrity is MD5-based (with the same gunzip fallback), and individual file integrity is ZIP CRC32-based after extraction.
9. Optional packages without detection markers default to `ignore` with a warning; explicit user override (`install`) is allowed and must also emit a warning.
10. `rememberAuth = false` must never persist credentials to `profiles.json`.
11. If `safeStorage` is unavailable, the app must remain functional (with warning behavior).
12. Language loading must merge with a fallback language (prefer `en`) so missing keys do not break the UI.
13. Main-process menu state must stay synchronized with renderer state (`menu:update-state`).

### iniBuilds-Specific Invariants
14. iniBuilds install uses dual-layer checksum verification: package-level MD5 (`filesIntegrityHash`) **and** per-file CRC32 after ZIP extraction. Neither layer may be removed independently.
15. iniBuilds manifest persistence (`manifest.json` in `<snapshotDir>/inibuilds/<profileId>/`) drives delete detection. Files present in the previous manifest but absent from the new ZIP become `delete` actions. Corrupting or omitting the manifest disables delete detection.
16. iniBuilds rollback snapshot (`#createRollbackSnapshot`) must be created **before** any file modifications in `installPlan`. Breaking snapshot creation breaks rollback.
17. iniBuilds auth is two-stage: Shopify Storefront GraphQL (`customerAccessTokenCreate`) → iniBuilds `/api/v4/login` token exchange. Direct-auth fallback payloads exist as a safety net and must not be removed.
18. Rollback is provider-agnostic: `updates:rollback-info` and `updates:rollback-last` dispatch to the provider's `getRollbackInfo()` / `rollbackLatestSnapshot()`. Both providers must implement these.

## Security and Privacy Rules
- Never log credentials.
- Do not add IPC endpoints without input validation (follow `assertObject`, `assertNonEmptyString` patterns).
- Only open external URLs after `http/https` validation.
- Never use unvalidated server paths for file operations.
- Do not bypass existing checksum verification logic.

## Change Rules by Area

### Profile and Persistence Changes
- Keep updates consistent across:
  - `lib/profile-store.js` (normalization, save behavior, public profile shape)
  - `src/renderer.js` (`collectProfileFromForm`, `fillForm`, dirty-check logic)
  - `src/index.html` (form fields)
  - `languages/*.json` (labels, placeholders, alerts)
  - `docs/user-guide.md` and, when relevant, `docs/data-and-security.md`
- Preserve backward compatibility for stored `profiles.json` where possible.

### IPC or Main/Renderer Contract Changes
- Always update all three layers:
  - `main.js` (handler)
  - `preload.js` (bridge function)
  - `src/renderer.js` (call site and error handling)
- For new runtime states, verify `syncActionButtons()` and menu enable/disable behavior.

### Update Engine Changes
- Be extra careful in `lib/update-client.js`:
  - Do not accidentally narrow auth strategy and retry behavior.
  - Avoid regressions in detection logic or `since` handling.
  - Ignore filtering may remove actions only; it must not corrupt plan summary semantics.
  - Install cancel/pause must remain responsive.
- Any behavior change must be reflected in `docs/update-engine.md`.

### iniBuilds Engine Changes
- Be extra careful in `lib/inibuilds-client.js`:
  - Do not break the two-stage Shopify auth → token exchange flow; fallback payload variants are intentional safety nets.
  - ZIP central directory parsing via HTTP range requests is the primary plan-building path. The full-download fallback is secondary — both paths must remain functional.
  - Manifest persistence (`#saveIniBuildsManifest` / `#loadIniBuildsManifest`) is critical for delete detection. Changes to manifest schema must preserve backward compatibility with stored `manifest.json` files.
  - Rollback snapshot creation (`#createRollbackSnapshot`) must remain **before** any file modifications in `installPlan`.
  - Per-file CRC32 verification after extraction must not be bypassed.
  - The plan-level ZIP validation fallback (MD5 mismatch but ZIP matches plan) must not be removed.
  - `AtomicFile` usage (via `lib/atomic-file.js`) for JSON writes must not be replaced with direct `fs.writeFile`.
- Any behavior change must be reflected in `docs/update-engine.md`.

### i18n Changes
- Add new UI strings to both `languages/en.json` and `languages/de.json`.
- Renderer uses `t(key, vars)`: do not introduce hardcoded user-facing strings in new UI/alerts/logs.
- For new tooltip/placeholder text, wire correct `data-i18n-*` attributes.

### UI Changes
- Keep existing class structure and responsive breakpoints unless you are intentionally redesigning.
- The file table must stay capped at 600 rendered rows for performance.
- For new controls, verify disabled behavior during running check/install operations.

## Validation Before Completion (Required Checklist)
1. Validate JSON files:
   - `languages/en.json`
   - `languages/de.json`
2. Confirm basic runtime flow without build/runtime errors (best effort):
   - app starts (`npm start` or `npm run start:linux`), if environment permits.
3. Manual smoke checks (minimum, maintainer-run):
   - save/load/delete profiles.
   - run check flow with a valid profile.
   - start install and test pause/resume/cancel.
   - switch language and verify persistence (`aerosync.language`).
4. Additional checks for engine changes:
   - verify `fresh` vs `repair` behavior.
   - verify ignore list matching (exact path, prefix, wildcard, basename rule).
   - verify snapshot update after successful install.
5. For build/release changes:
   - cross-check `.github/workflows/build-packages.yml` with `package.json` build targets.

If any check cannot be run locally (including manual smoke checks), explicitly state that in the final report.

## Build and Release Notes
- Local builds:
  - `npm run build:appimage`
  - `npm run build:deb`
  - `npm run build:rpm`
  - `npm run build:win:setup`
  - `npm run build:win:portable`
- CI release is triggered by pushing a tag.
- Uploaded assets: `*.AppImage`, `*.deb`, `*.rpm`, `*-setup.exe`, `*-portable.exe`.
- `.blockmap` files are intentionally not published as release assets.

## Documentation Requirement
When behavior changes, update matching docs:
- User flow: `docs/user-guide.md`
- Engine internals: `docs/update-engine.md`
- Storage/security: `docs/data-and-security.md`
- Operational issues: `docs/troubleshooting.md`

## Non-Goals / Avoid
- Do not add unnecessary runtime dependencies.
- Do not introduce silent API contract breaks between main/preload/renderer.
- Do not weaken path or checksum validation.
- Do not leave i18n keys half-updated across `en` and `de`.