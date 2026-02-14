# AeroSync Addon Updater (Electron)

Desktop updater for X-Plane aircraft add-ons that use the X-Updater service.
This app is designed for managing multiple aircraft profiles in one place.

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

- Linux desktop environment with GUI
- Node.js + npm

## Run

1. Install dependencies:

```bash
npm install
```

2. Start the app:

```bash
npm start
```

## Build AppImage (Linux)

1. Install dependencies (including build tools):

```bash
npm install
```

2. Build the AppImage:

```bash
npm run build:appimage
```

3. Output location:

- The AppImage will be created in `dist/`.
- Example: `dist/AeroSync Addon Updater-0.1.0-x64.AppImage`

## Language System

- English is the default application language.
- Languages are loaded from `languages/` in the current working directory.
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
