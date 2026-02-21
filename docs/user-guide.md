# User Guide

## Profiles

Each profile represents one aircraft installation.

Fields:

- `Profile Name`: free label in the sidebar
- `Update Host`: default is `https://update.x-plane.org`
- `Product Directory`: base folder of the product on disk
- `Login / Email`: account login for the updater service
- `License Key`: license key for the product
- `Update provider`: currently `X-Updater`; `iniBuilds` is prepared in profile data model for future native integration
- `Release Channel`: `release`, `beta`, or `alpha`
- `Snapshot number (since)`: baseline snapshot for incremental checks
- `Ignore list`: paths or patterns to skip during plan/install (one per line)
- `Fresh Install`: force full reconciliation against current snapshot
- `Repair / Verify`: hash-check all known files and re-download mismatches
- `Store credentials in profile`: save credentials for reuse; if disabled, credentials stay only in the current app session

## Release Channel Behavior

- `release`: stable snapshot only
- `beta`: beta if available, otherwise fallback to release with warning
- `alpha`: alpha if available; if not, fallback to beta/release with warning

## What "Snapshot number (since)" Means

This value is sent as `since` to the files endpoint (when supported).
It defines from which snapshot onward changes are requested.

- Higher value = smaller incremental plan if you are up to date
- `0` = broad/full change list from server perspective
- With `Fresh Install` or `Repair / Verify`, `since` is ignored

## Standard Workflow

1. Select or create profile.
2. Save profile.
3. Click `Check Updates`.
4. Review optional package choices (`Install` / `Ignore`) and, if needed, change them in the `Optional packages` panel.
5. Review summary and file plan.
6. Click `Install`.
7. Wait until completion.

After a successful install, the app updates `Snapshot number (since)` automatically to the new snapshot.
If profile fields changed, `Check Updates` auto-saves the profile before starting.

## Update Modes

Normal update:

- Uses file state and hash checks
- Skips files that are already correct
- Applies server `DELETE` actions when needed

Fresh install:

- Rebuilds full target state
- Adds delete actions for local files not present on server list
- Useful for cleaning inconsistent product folders

Repair / Verify:

- Requests full known file list and checks local hashes
- Re-downloads files that are missing or hash-mismatched
- Does not perform fresh cleanup deletes for unknown extra local files
- Best for fixing broken installs without aggressive cleanup

`Fresh Install` and `Repair / Verify` are mutually exclusive in the UI.

Optional packages are listed in the `Optional packages` panel:

- each package can be set to `Install` or `Ignore`
- defaults are based on detection markers (`Install` when detected, `Ignore` when missing)
- changing a package action triggers a fresh check and rebuilds the plan

## During Installation

Available controls:

- `Pause`: waits at safe boundary between file actions
- `Resume`: continues processing actions
- `Cancel`: aborts current run and marks run as cancelled
- `Rollback`: restores the latest pre-install snapshot for the selected profile

While check/install is running, profile switching, profile edits, and language switching are blocked.

## Rollback Snapshot

Before every installation, the app creates a rollback snapshot for the selected profile.

- snapshot includes all files that will be changed or deleted by the install plan
- `Rollback` restores backed-up files and removes files that were newly created by the failed/undesired install
- only the latest snapshot per profile is used for rollback
- after rollback, run `Check Updates` again before starting a new install

## App Menu And Shortcuts

The native menu provides the same core actions as the UI.

Examples:

- `F5`: Check updates
- `Ctrl/Cmd + I`: Install updates
- `Ctrl/Cmd + P`: Pause/Resume installation
- `Esc`: Cancel installation
- `Ctrl/Cmd + S`: Save profile
- `Ctrl/Cmd + O`: Open aircraft folder
- `Ctrl/Cmd + L`: Clear log
- `Ctrl/Cmd + U`: Check app update

Additional menu actions (top bar):

- `File -> Import Profiles...`: load profiles from a JSON export
- `File -> Export Profiles...`: export all current profiles to JSON
- `Actions -> Export Diagnostics...`: export a diagnostics JSON (runtime + anonymized profile summary + current UI log)

## Provider Support

- `X-Updater` is fully supported for check/install/rollback.
- `iniBuilds` is now wired as a dedicated provider client in the app architecture and can be selected/saved in profiles.
- When `iniBuilds` is selected, update actions currently show a clear "not implemented yet" message.

## App Update Checker

The app can check whether a newer AeroSync version is available on GitHub.

How to run it:

- top bar button: `Check app update`
- menu: `Actions -> Check App Update`
- shortcut: `Ctrl/Cmd + U`

What it does:

- reads your installed app version
- requests the latest release metadata from GitHub
- compares versions and reports `update available` or `up to date`
- prompts to open the release page when an update is found

The checker does not auto-download or auto-install app updates.

## Planned File Plan Table

- The table supports text search (package name and file path), action filter (`All` / `Update` / `Delete`), and page size selection.
- Results are paginated with previous/next navigation.
- For performance, each page renders at most 600 rows.
- The entry counter shows either total entries or filtered/total entries when filters are active.

## Ignore List

Use one entry per line in the profile field.

Supported entries:

- exact relative path (for example `objects/test.obj`)
- folder prefix with trailing slash (for example `liveries/`)
- simple wildcard patterns (for example `objects/**/*.dds`)
- file name without slash matches in any folder (for example `thumbs.db`)
- lines starting with `#` are comments

Ignored files are removed from the action plan and counted in check summary/log output.
