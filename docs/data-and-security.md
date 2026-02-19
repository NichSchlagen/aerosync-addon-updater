# Data, Storage, and Security

## Profile Storage

Profiles are stored in Electron `userData` directory as `profiles.json`.

Linux default path:

- `~/.config/aerosync-addon-updater/profiles.json`

## Profile Import / Export

Top-bar menu actions:

- `File -> Export Profiles...`
- `File -> Import Profiles...`

Export format:

- JSON payload with schema marker `aerosync.profiles.v1`
- includes profile configuration fields (`name`, `host`, `productDir`, `channel`, `packageVersion`, `ignoreList`)
- includes credentials only when `rememberAuth` is enabled and credentials are currently available in memory

Import behavior:

- merges/upserts by profile `id`
- invalid entries are skipped with warnings/errors
- if an entry has `rememberAuth = true` but missing login/key, import disables `rememberAuth` for that entry

## What Is Stored

Per profile:

- identity: id, name, timestamps
- connection: host, product directory
- update state: channel, packageVersion
- rules: ignoreList
- auth mode: rememberAuth flag
- credentials: login/license key (only if `Store credentials` is enabled)

## Credentials Without Storage

If `Store credentials in profile` is disabled:

- login/key are not written to `profiles.json`
- credentials are only used from current form input during check/install
- you need to enter them again after app restart

## Credential Encryption

When Electron `safeStorage` is available:

- credentials are encrypted before writing to disk
- stored format uses scheme `safeStorage.v1`

If `safeStorage` is unavailable:

- app continues working
- credentials are stored as plain text
- warning is logged in main process

If encrypted credentials cannot be decrypted (for example keyring/OS change):

- stored values are treated as unavailable
- you must re-enter login/key and save profile again

## Language Files

Language directory resolution order:

1. `AEROSYNC_LANG_DIR` (if set)
2. packaged resource directory (`process.resourcesPath/languages`)
3. bundled app path (`app.getAppPath()/languages`)
4. user fallback language directory

Language JSON requires:

- `meta` (`code`, `name`, optional `locale`)
- `messages` object

English acts as fallback merge base when available.
Broken language JSON files are ignored until fixed.

## Language Preference Storage

The selected UI language is also stored locally in browser storage:

- key: `aerosync.language`
- scope: renderer local storage for this app

## Diagnostics Export

Top-bar menu action:

- `Actions -> Export Diagnostics...`

Diagnostics export format:

- JSON payload with schema marker `aerosync.diagnostics.v1`
- includes app/runtime metadata, current UI state, anonymized profile summary, and current log output
- sensitive-looking fields are redacted during export in main process (for example keys containing `password`, `token`, `license`, `login`, `credential`, `auth`)

## Plan Cache

Update plans are kept in memory (`planCache`) and tied to profile id.
A plan must be installed by the same profile it was created for.

## Install Snapshots (Rollback)

Before each installation, the app stores a rollback snapshot in user data:

- Linux default base: `~/.config/aerosync-addon-updater/install-snapshots/`
- snapshots are grouped per profile id
- each snapshot stores a manifest plus backed-up file copies for affected paths
- rollback consumes the latest snapshot for that profile and removes it after successful restore
