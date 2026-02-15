# User Guide

## Profiles

Each profile represents one aircraft installation.

Fields:

- `Profile Name`: free label in the sidebar
- `Update Host`: default is `https://update.x-plane.org`
- `Product Directory`: base folder of the product on disk
- `Login / Email`: account login for the updater service
- `License Key`: license key for the product
- `Release Channel`: `release`, `beta`, or `alpha`
- `Snapshot number (since)`: baseline snapshot for incremental checks
- `Ignore list`: paths or patterns to skip during plan/install (one per line)
- `Fresh Install`: force full reconciliation against current snapshot
- `Repair / Verify`: hash-check all known files and re-download mismatches
- `Store credentials in profile`: save credentials for reuse

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
4. Review summary and file plan.
5. Click `Install`.
6. Wait until completion.

After a successful install, the app updates `Snapshot number (since)` automatically to the new snapshot.

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
- Does not perform fresh cleanup deletes for unknown extra files
- Best for fixing broken installs without aggressive cleanup

`Fresh Install` and `Repair / Verify` are mutually exclusive in the UI.

## During Installation

Available controls:

- `Pause`: waits at safe boundary between file actions
- `Resume`: continues processing actions
- `Cancel`: aborts current run and marks run as cancelled

While check/install is running, profile switching and profile edits are blocked.

## App Menu And Shortcuts

The native menu provides the same core actions as the UI.

Examples:

- `F5`: Check updates
- `Ctrl/Cmd + I`: Install updates
- `Ctrl/Cmd + P`: Pause/Resume installation
- `Esc`: Cancel installation
- `Ctrl/Cmd + S`: Save profile

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

## Ignore List

Use one entry per line in the profile field.

Supported entries:

- exact relative path (for example `objects/test.obj`)
- folder prefix with trailing slash (for example `liveries/`)
- simple wildcard patterns (for example `objects/**/*.dds`)
- lines starting with `#` are comments

Ignored files are removed from the action plan and counted in check summary/log output.
