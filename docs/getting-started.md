# Getting Started

## Requirements

- Node.js 20+
- npm 10+
- Linux desktop with GUI (for local app run)

## Install Dependencies

```bash
npm install
```

## Run In Development

```bash
npm start
```

If your Linux environment needs it:

```bash
npm run start:linux
```

## Build Packages

Linux AppImage:

```bash
npm run build:appimage
```

Linux DEB:

```bash
npm run build:deb
```

Linux RPM:

```bash
npm run build:rpm
```

Note: `rpmbuild` is required for local RPM builds. On Debian/Ubuntu:

```bash
sudo apt-get install rpm
```

All Linux variants:

```bash
npm run build:linux
```

Windows setup EXE:

```bash
npm run build:win:setup
```

Windows portable EXE:

```bash
npm run build:win:portable
```

Both Windows variants:

```bash
npm run build:win
```

Artifacts are generated in `dist/`.

## First App Setup

1. Create a new profile.
2. Set product directory to your aircraft folder.
3. Enter your account login/email and license key.
4. Pick a channel (`release`, `beta`, or `alpha`).
5. Keep `Snapshot number (since)` at your last installed snapshot (or `0` if unknown).
6. Click `Check Updates`.
7. Review plan, then click `Install`.
