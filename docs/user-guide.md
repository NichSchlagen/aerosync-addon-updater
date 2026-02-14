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
- `Fresh Install`: force full reconciliation against current snapshot
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
- With `Fresh Install`, `since` is ignored

## Standard Workflow

1. Select or create profile.
2. Save profile.
3. Click `Check Updates`.
4. Review summary and file plan.
5. Click `Install`.
6. Wait until completion.

After a successful install, the app updates `Snapshot number (since)` automatically to the new snapshot.

## During Installation

Available controls:

- `Pause`: waits at safe boundary between file actions
- `Resume`: continues processing actions
- `Cancel`: aborts current run and marks run as cancelled

While check/install is running, profile switching and profile edits are blocked.

## Fresh Install vs Normal Update

Normal update:

- Uses file state and hash checks
- Skips files that are already correct
- Applies server `DELETE` actions when needed

Fresh install:

- Rebuilds full target state
- Adds delete actions for local files not present on server list
- Useful for cleaning inconsistent product folders
