# Troubleshooting

## HTTP 401 (Authentication Failed)

Symptoms:

- check fails with `HTTP 401`

Actions:

1. verify login/email and license key
2. re-save profile
3. retry check

## Stored Credentials Cannot Be Used

Symptoms:

- check fails with message about credentials that cannot be decrypted
- stored login/key are unexpectedly empty

Actions:

1. enter login and license key again in the form
2. keep `Store credentials in profile` enabled
3. save profile
4. run `Check Updates` again

## App Update Check Failed

Symptoms:

- status shows `App update check failed`
- alert dialog appears with an HTTP/network error

Possible causes:

- temporary network issue
- GitHub API rate limit (`HTTP 403`)
- no published release yet (`HTTP 404`)

Actions:

1. retry after a short delay
2. open `https://github.com/NichSchlagen/aerosync-addon-updater/releases` manually
3. compare your installed version chip (`vX.Y.Z`) with the latest release tag

## No Updates Shown But Folder Is Empty

Possible causes:

- channel/snapshot combination yields no delta from selected `since`
- `since` value is too high for your actual local state

Actions:

1. set `Snapshot number (since)` to `0`
2. enable `Fresh Install`
3. if still unexpected, enable `Repair / Verify`
4. run `Check Updates` again

## Optional Package Missing From Plan

Symptoms:

- package is shown in `Optional packages`, but expected files are missing from plan
- log shows a hint that the package was ignored or skipped

Actions:

1. in `Optional packages`, set the package action to `Install`
2. run `Check Updates` again (the app also does this automatically when action changes)
3. verify profile `Product Directory` points to the correct aircraft root
4. if markers are expected, verify marker files/folders exist locally

## Installed Version Is "Latest" But Plan Still Looks Wrong

Actions:

1. disable `Fresh Install`
2. enable `Repair / Verify`
3. run `Check Updates`
4. install the repair plan

This mode verifies all known files by hash and repairs missing/corrupted ones.

## Checksum Mismatch During Install

Symptoms:

- install fails with checksum mismatch for specific file

What app already does:

- verifies raw file hash
- retries by gunzip + hash check if raw hash does not match

Actions:

1. run check again to create a new plan
2. retry install
3. if it keeps failing, run `Repair / Verify` mode once
4. if persistent, open a GitHub issue with exact error and file path

## Planned File Table Looks Incomplete

Symptoms:

- summary/counter shows many actions
- table shows fewer rows than expected

Cause:

- UI renders up to 600 rows for performance

Actions:

1. rely on summary and action counter for total size/count
2. install is still processed against full internal plan

## Alpha/Beta Not Available

The app may fallback automatically to the next available channel snapshot and record a warning.
Check the warnings count and log entries after `Check Updates`.

## Cannot Switch Profile During Run

This is expected. Profile switching is blocked while check/install is running to prevent plan/profile mismatch.

## Windows Builds

Windows setup and portable builds are currently not tested by the maintainer.
If you run into problems, open a GitHub issue and include:

- error message
- what you clicked
- reproduction steps
- app version and OS
