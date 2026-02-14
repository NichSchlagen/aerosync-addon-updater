# AeroSync Addon Updater (Electron)

Desktop updater for X-Plane aircraft add-ons that use the X-Updater service.
This app is designed for managing multiple aircraft profiles in one place.

## Documentation

Full documentation is available in [`docs/`](./docs/README.md):

- Getting Started
- User Guide
- Update Engine internals
- Data, storage, and security
- CI/CD release flow
- Troubleshooting

## What This App Does

- Manage multiple profiles (different aircraft folders, channels, and credentials)
- Authenticate against `https://update.x-plane.org`
- Check updates for `release`, `beta`, or `alpha`
- Build update plans (including fresh install mode)
- Verify files with MD5
- Download, unpack (gzip when required), and install updates
- Pause, resume, and cancel running installations

## Original Jar Client Notes

If you want to use the official Java client instead:

- `X-Updater-Client.jar` must be in the aircraft root folder
- If missing, download it from `https://x-updater.com/`
- Java 8 runtime is required for the jar client (`https://www.java.com/`)
- This Electron app talks directly to the update API and does not require Java 8

## Current Project Structure

- `main.js`: Electron main process and IPC handlers
- `preload.js`: secure renderer bridge (`window.aeroApi`)
- `lib/profile-store.js`: profile storage and credential handling
- `lib/language-store.js`: external language loading
- `lib/update-client.js`: update engine (auth, check, install)
- `src/`: UI files (HTML/CSS/renderer logic)
- `languages/`: editable language files (`*.json`)

## Requirements

- Node.js 20+
- npm 10+
- Linux desktop environment with GUI (for local Linux run/build)

## Development Run

1. Install dependencies:

```bash
npm install
```

2. Start the app:

```bash
npm start
```

On Linux, if needed, use:

```bash
npm run start:linux
```

## Local Build Process

All build output is written to `dist/`.

### Linux AppImage

```bash
npm run build:appimage
```

Expected artifact pattern:

- `dist/AeroSync.Addon.Updater-<version>-x86_64.AppImage`

### Windows Setup EXE (NSIS)

```bash
npm run build:win:setup
```

Expected artifact pattern:

- `dist/AeroSync.Addon.Updater-<version>-x64-setup.exe`

### Windows Portable EXE

```bash
npm run build:win:portable
```

Expected artifact pattern:

- `dist/AeroSync.Addon.Updater-<version>-x64-portable.exe`

### Build Both Windows Variants

```bash
npm run build:win
```

Windows setup and portable builds are currently not tested by the maintainer.
If you run into problems, please open a GitHub issue with:

- the error description/message
- the steps that trigger the issue


## Language System

- English is the default application language.
- In packaged builds (AppImage/Windows), languages are loaded from bundled app resources automatically.
- In development, languages are loaded from the local `languages/` folder.
- You can override the language directory with:

```bash
AEROSYNC_LANG_DIR=/path/to/your/languages npm start
```

- Language file schema:

```json
{
  "meta": {
    "code": "en",
    "name": "English",
    "locale": "en-US"
  },
  "messages": {
    "btn.checkUpdates": "Check Updates"
  }
}
```

## Contributing Translations

New languages are very welcome.
If you add or improve a translation, please open a Pull Request on GitHub and include the new `languages/<code>.json` file.

## Notes

- The remote update API may change over time; endpoint and payload mapping may require updates.
