# How The Update Engine Works

## Provider Routing

Each profile stores an update `provider`.

- default: `xupdater`
- prepared for future extension: `inibuilds`

At runtime, IPC handlers resolve the provider from the profile and route `check`, `install`, and `rollback` operations to the matching provider client.
Current status:

- `xupdater` -> fully implemented by `lib/update-client.js`
- `inibuilds` -> dedicated client exists in `lib/inibuilds-client.js`
  - implemented: auth request + product-list probe during `createUpdatePlan`
  - pending: file plan creation, download/install pipeline, rollback snapshot handling
  - endpoint paths are configurable via environment variables (`AEROSYNC_INIBUILDS_*`)

## 1) Authentication

The app authenticates against:

- `POST /api/v2/service/auth/consumers`

It tries multiple header strategies derived from the auth response (authorization token candidates plus basic credentials fallback).

## 2) Product Discovery

The app loads product information from:

- `GET /api/v2/experimental/updates`

It normalizes product trees, flattens sub-products, and picks one snapshot per product based on channel options.

## 3) Snapshot Selection

Snapshot priority by selected channel:

- alpha requested: alpha -> beta -> release -> first available
- beta requested: beta -> release -> first available
- release requested: release -> first available

Fallbacks are added as warnings in the plan.

## 4) File Plan Creation

For each product:

- fetch file list (`xu:files` link)
- resolve target directory from product location + detection rules
- for products with detection markers, expose package decision `install` / `ignore`
- default decision is `install` when markers are detected, otherwise `ignore`
- if an optional package is set to ignore, skip it with warning
- if an optional package is forced to install without markers, include it and add warning
- build actions depending on selected mode

Mode behavior:

- Normal mode:
  - uses `since = profile.packageVersion`
  - creates `update` for needed ADD/UPDATE items
  - creates `delete` for server `DELETE` items
- Fresh mode:
  - forces `since = 0`
  - normal mode behavior plus cleanup deletes for local files not present on server list
- Repair/verify mode:
  - forces `since = 0`
  - hash-checks all known files from server list
  - creates `update` for missing/hash-mismatched files
  - skips fresh cleanup deletes for unknown extra local files

Actions are ordered as:

1. all deletes
2. all updates

## 5) Ignore Filtering

After actions are built, ignore rules are applied.

- rules can match exact paths, folder prefixes, wildcards, or basename-only entries
- ignored actions are removed from the final plan
- summary keeps `ignoredCount` and warnings mention skip count

## 6) Size Summary

Summary includes:

- `downloadSizeKnown`: compressed sizes that are known
- `downloadSizeEstimatedMax`: known compressed + fallback-to-real-size estimates
- `downloadSizeUnknownCount`: number of files without compressed size
- `diskSize`: sum of target real sizes for update actions

This is why network download can be much smaller than disk size.

## 7) Install Execution

Before processing actions, the app creates a rollback snapshot for the selected profile.

- each affected relative path is captured once
- existing local files are copied to snapshot storage
- missing files are tracked so rollback can remove them later

For each action:

- emit progress event
- if delete: remove file and clean empty parent dirs
- if update:
  - download payload
  - verify MD5
  - if raw hash mismatch, try gunzip and verify again
  - handle empty marker files explicitly
  - copy verified result to target

If checksum remains wrong, install fails with a checksum mismatch error.

## 8) Rollback Execution

Rollback uses the latest available snapshot for the selected profile.

- restore backed-up files in reverse order
- remove files that did not exist before install
- clean up empty parent directories where possible
- remove consumed snapshot after successful rollback

## 9) Completion

On success:

- plan is removed from cache
- result returns updated/deleted counts and target snapshot
- profile `packageVersion` is updated to new snapshot number
