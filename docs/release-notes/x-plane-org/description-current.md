# X-Plane.org Description (Current)

Hi everyone,

I built a desktop app called AeroSync Addon Updater.

It is an unofficial multi-profile updater for aircraft that use either the X-Updater service or iniBuilds.

## Platforms

- Linux (AppImage + DEB + RPM)
- Windows (Installer + Portable)

Windows installer and portable builds are currently not fully tested by me.

If you run into issues, please open a GitHub issue with the error message and steps to reproduce:

https://github.com/NichSchlagen/aerosync-addon-updater/issues

## Why I made it

The original workflow is mostly focused on one aircraft/client at a time.

I wanted a cleaner way to manage multiple aircraft profiles in one place.

## Main features

- Manage multiple aircraft profiles in one app (since v1.0.0)
- Choose update channel: Release / Beta / Alpha (X-Updater profiles) (since v1.0.0)
- Fresh Install mode (since v1.0.0)
- Preview planned file changes before installing (since v1.0.0)
- Reliable update/install process with checksum verification (MD5 + provider-specific validation) (since v1.0.0)
- Pause / Resume / Cancel during installation (since v1.0.0)
- Ignore list to skip selected files or folders (since v1.0.0)
- Automatic snapshot update after successful install (since v1.0.0)
- Easy language support via external translation files (since v1.0.0)
- Repair / Verify mode (checks files and repairs missing/corrupt ones) (since v1.2.0)
- Built-in app update checker (GitHub releases) (since v1.2.0)
- Native app menu + keyboard shortcuts (since v1.2.0)
- Optional package control (Install / Ignore, with manual override if needed) (since v1.3.0)
- Search, action filter, and pagination in the planned file table (since v1.4.0)
- Profile import/export via app menu (since v1.4.0)
- Diagnostics export for troubleshooting (since v1.4.0)
- Pre-install snapshot creation per profile for safer updates (since v1.5.0)
- Rollback to the last install state (restore backed-up files, remove newly added files) (since v1.5.0)
- Provider selection per profile: X-Updater or iniBuilds (since v2.0.0)
- iniBuilds account login + owned product selection (since v2.0.0)
- iniBuilds activation key retrieval and profile persistence (since v2.0.0)

GitHub: https://github.com/NichSchlagen/aerosync-addon-updater

## Release policy

On x-plane.org, I only publish major releases and feature releases.

Patch/bugfix releases are published on GitHub only.

Latest build (always up to date):

https://github.com/NichSchlagen/aerosync-addon-updater/releases/latest

## Important

- This is a private, non-commercial hobby project.
- This is not an official product of any aircraft developer.
- Linux support is the current focus.
- Use at your own risk and keep backups.

Feedback, bug reports, and translation PRs are very welcome.
