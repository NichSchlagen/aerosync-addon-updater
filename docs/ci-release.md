# CI/CD and Release Flow

## Trigger

GitHub workflow `.github/workflows/build-packages.yml` runs on:

- push of any tag

Example:

```bash
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

## Build Matrix

The workflow builds:

- Linux AppImage on `ubuntu-latest`
- Windows setup EXE on `windows-latest`
- Windows portable EXE on `windows-latest`

Build jobs run with `--publish never`.

## Release Publishing

A separate release job:

1. downloads build artifacts
2. publishes GitHub release assets with `softprops/action-gh-release`

Uploaded release files are limited to:

- `*.AppImage`
- `*-setup.exe`
- `*-portable.exe`

`.blockmap` files are intentionally not uploaded.

## Versioning Notes

Recommended flow per release:

1. update `package.json` version
2. commit and push
3. create annotated tag
4. push tag
5. verify release assets in GitHub Releases
