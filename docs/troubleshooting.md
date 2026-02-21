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

## "Provider Not Implemented" Message

Symptoms:

- check or rollback shows a message that the selected provider is not implemented yet

Cause:

- profile is set to a provider that is not yet supported

Actions:

1. open profile settings
2. switch `Update provider` to `X-Updater` or `iniBuilds`
3. save profile
4. run `Check Updates` again

## Profile Import Failed

Symptoms:

- dialog after `File -> Import Profiles...` shows an error
- no profiles are added/updated

Possible causes:

- selected file is not valid JSON
- JSON contains no `profiles` array
- all entries are invalid (for example missing `name` or `productDir`)

Actions:

1. validate JSON syntax
2. ensure payload includes a `profiles` array (or a root array) with profile objects
3. re-export from another AeroSync instance and import that file

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
5. attach a diagnostics export from `Actions -> Export Diagnostics...`

## Planned File Table Looks Incomplete

Symptoms:

- summary/counter shows many actions
- table page shows fewer rows than expected

Cause:

- active search/filter hides entries
- selected page size limits rows shown per page
- UI renders at most 600 rows per page for performance

Actions:

1. clear search text and set action filter to `All`
2. increase `Rows per page` if needed
3. switch page using previous/next controls
4. rely on summary and action counter for full totals
5. install is still processed against full internal plan

## Diagnostics Export Failed

Symptoms:

- `Actions -> Export Diagnostics...` fails

Possible causes:

- selected target file is not writable
- filesystem permission or disk-space issue

Actions:

1. retry and choose another directory
2. verify write permissions and available disk space

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
- diagnostics export file from `Actions -> Export Diagnostics...`
