# How The Update Engine Works

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
- build actions:
  - `delete` actions for server `DELETE`
  - `update` actions for ADD/UPDATE or hash mismatch
  - in fresh mode: additional deletes for local files absent on server

Actions are ordered as:

1. all deletes
2. all updates

## 5) Size Summary

Summary includes:

- `downloadSizeKnown`: compressed sizes that are known
- `downloadSizeEstimatedMax`: known compressed + fallback-to-real-size estimates
- `downloadSizeUnknownCount`: number of files without compressed size
- `diskSize`: sum of target real sizes for update actions

This is why network download can be much smaller than disk size.

## 6) Install Execution

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

## 7) Completion

On success:

- plan is removed from cache
- result returns updated/deleted counts and target snapshot
- profile `packageVersion` is updated to new snapshot number
