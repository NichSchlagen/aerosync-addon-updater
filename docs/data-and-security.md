# Data, Storage, and Security

## Profile Storage

Profiles are stored in Electron `userData` directory as `profiles.json`.

Linux default path:

- `~/.config/<app-name>/profiles.json`

## What Is Stored

Per profile:

- identity: id, name, timestamps
- connection: host, product directory
- update state: channel, packageVersion
- credentials: login/license key (if `Store credentials` enabled)

## Credential Encryption

When Electron `safeStorage` is available:

- credentials are encrypted before writing to disk
- stored format uses scheme `safeStorage.v1`

If `safeStorage` is unavailable:

- app continues working
- credentials are stored as plain text
- warning is logged in main process

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

## Plan Cache

Update plans are kept in memory (`planCache`) and tied to profile id.
A plan must be installed by the same profile it was created for.
