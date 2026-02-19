# Troubleshooting Playbook for AeroSync Addon Updater

This playbook provides step-by-step procedures for diagnosing and resolving common issues.

## How to Read Application Logs

### Log Location
- **Development**: Console output (stdout/stderr)
- **Production**: Check terminal if launched from command line
- **Packaged App**: Typically not visible unless redirected

### Log Format
```
[TIMESTAMP] [LEVEL] [CONTEXT] [CORRELATION_ID] MESSAGE {metadata}
```

Example:
```
[2026-02-19T08:47:44.717Z] [INFO] [update-client] [update-check-a1b2c3d4] Creating update plan {profileName: "MyAircraft", channel: "release"}
```

### Log Levels
- **DEBUG**: Detailed diagnostic information
- **INFO**: Normal operations (startup, completion, user actions)
- **WARN**: Potential issues (encryption unavailable, retries)
- **ERROR**: Failures requiring attention

### Reading Correlation IDs
- Format: `{operation}-{randomHex}`
- Examples: `update-check-a1b2c3d4`, `install-f5e4d3c2`
- Use to trace a single operation through multiple log lines

### Key Log Patterns

**Successful Update Check**:
```
[INFO] [update-client] [update-check-*] Creating update plan
[DEBUG] [update-client] Authorization successful
[DEBUG] [update-client] Product info fetched
[INFO] [update-client] [update-check-*] Update plan created {fileCount, downloadSizeMB}
```

**Failed Authentication**:
```
[WARN] [update-client] HTTP error response {url, status: 401}
```

**Installation Progress**:
```
[INFO] [update-client] [install-*] Starting installation {planId, profileName}
[INFO] [update-client] [install-*] Installation completed {updated, deleted, durationSeconds}
```

**Credential Issues**:
```
[ERROR] [profile-store] Credential decryption failed
[WARN] [main] safeStorage encryption unavailable
```

## Common Problems and Solutions

### 1. Authentication Failures (HTTP 401)

**Symptoms**:
- "Authentication failed (HTTP 401)"
- Update check fails immediately
- Log shows: `HTTP error response {status: 401}`

**Root Causes**:
- Incorrect login/license key
- Credentials not saved in profile
- Credential decryption failure

**Diagnosis Steps**:
1. Check if "Store credentials in profile" is enabled
2. Look for credential decryption errors in logs
3. Verify credentials work in original X-Updater client

**Solutions**:
- Re-enter login and license key in profile form
- Enable "Store credentials in profile" checkbox
- Save profile after entering credentials
- If safeStorage unavailable, accept plaintext warning

**Prevention**:
- Always test credentials immediately after entry
- Export profiles regularly as backup

---

### 2. Profile Corruption / Load Failure

**Symptoms**:
- Profiles list is empty after restart
- Error: "Failed to read profiles"
- Application crashes on startup

**Root Causes**:
- Invalid JSON in `profiles.json`
- Disk full during save
- Concurrent write corruption (rare after fixes)
- Manual file editing error

**Diagnosis Steps**:
1. Locate `profiles.json` in userData directory:
   - Linux: `~/.config/AeroSync Addon Updater/profiles.json`
   - Windows: `%APPDATA%\AeroSync Addon Updater\profiles.json`
2. Open file in text editor and check JSON validity
3. Look for `.tmp-*` files in same directory
4. Check logs for write errors

**Solutions**:
- If JSON invalid: restore from backup or fix manually
- If `.tmp-*` files exist: delete them and restart
- If no backup: import profiles from exported file
- Last resort: delete `profiles.json` (creates fresh empty db)

**Prevention**:
- Export profiles regularly (File → Export Profiles)
- Don't edit profiles.json manually
- Ensure adequate disk space

---

### 3. Installation Hangs / Never Completes

**Symptoms**:
- Progress bar stops updating
- Specific file never completes downloading
- Application appears frozen
- Log shows same action repeating

**Root Causes**:
- Network connectivity loss
- Server not responding
- Very large file download
- Disk full
- Temp directory permissions

**Diagnosis Steps**:
1. Check correlation ID in logs to find stuck operation
2. Note the file path being processed
3. Check network connectivity
4. Verify disk space: `df -h` (Linux) or check drive properties
5. Check temp directory: `ls -la $(node -e "console.log(require('os').tmpdir())")`

**Solutions**:
- Cancel installation and retry
- Check internet connection
- Free up disk space
- Verify temp directory is writable
- If specific file always fails: add to ignore list

**Prevention**:
- Ensure stable internet connection
- Keep at least 5GB free disk space
- Monitor progress during large downloads

---

### 4. Checksum Mismatch Errors

**Symptoms**:
- "Checksum mismatch for {file}"
- Installation fails after download
- Log shows: `expected {hash}, got {hash}`

**Root Causes**:
- Download corruption (network issue)
- Server file changed during update
- Disk write error
- Gunzip decompression failure

**Diagnosis Steps**:
1. Note which file(s) consistently fail
2. Check if error mentions "gunzip failed"
3. Try repair mode (forces re-download all)
4. Check disk health

**Solutions**:
- Retry update check and install
- Use repair mode: enable "Repair/Verify" option
- If persistent: report to add-on developer
- Check for disk errors: `sudo fsck` (Linux)

**Prevention**:
- Use stable wired connection for large updates
- Run repair mode periodically to verify integrity

---

### 5. Temp File Accumulation

**Symptoms**:
- Disk space slowly decreases
- Many `updater-download-*.tmp` files in temp directory
- Temp directory grows over time

**Root Causes**:
- Cleanup failure after crash
- Incomplete installations
- Very old temp files not removed

**Diagnosis Steps**:
1. Find temp directory: `node -e "console.log(require('os').tmpdir())"`
2. Count updater temp files: `ls -la /tmp/updater-*.tmp | wc -l`
3. Check file ages: `ls -lth /tmp/updater-*.tmp | head`

**Solutions**:
- Manual cleanup: `rm /tmp/updater-*.tmp`
- Restart application (triggers cleanup)
- Clear system temp directory

**Prevention**:
- Updated app version includes automatic cleanup
- Restart app after failed installations

---

### 6. Plan Expired / Not Found

**Symptoms**:
- "Update plan not found"
- Install button fails after check succeeded
- Logs show: "Plan not found in cache"

**Root Causes**:
- More than 30 minutes passed since check
- Plan cache was manually cleared
- Different profile selected

**Diagnosis Steps**:
1. Check time since last update check
2. Verify same profile is selected
3. Check logs for plan cache cleanup

**Solutions**:
- Run update check again (F5)
- Verify correct profile is selected
- Plans expire after 30 minutes

**Prevention**:
- Install updates promptly after checking
- Don't switch profiles between check and install

---

### 7. Language Files Not Loading

**Symptoms**:
- UI shows translation keys instead of text (e.g., "btn.checkUpdates")
- Language dropdown is empty
- Logs show: "No language files found"

**Root Causes**:
- Language directory not found
- Invalid JSON in language file
- Missing language files in package

**Diagnosis Steps**:
1. Check language directory in logs (startup)
2. Verify files exist: `ls -la {langDir}/*.json`
3. Test JSON validity: `jq . {langDir}/en.json`

**Solutions**:
- Reinstall application
- Set custom language directory: `AEROSYNC_LANG_DIR=/path npm start`
- Check language file structure matches schema

**Prevention**:
- Don't delete language files from installation
- Report missing translations as issues

---

### 8. Memory Usage Growing Over Time

**Symptoms**:
- Application uses more RAM over hours
- System becomes sluggish
- Many update checks without installs

**Root Causes**:
- Plan cache not cleaning expired plans (fixed in recent version)
- Memory leak in renderer process
- Too many update checks without cleanup

**Diagnosis Steps**:
1. Check plan cache size in logs
2. Monitor memory with task manager
3. Count update checks vs installs

**Solutions**:
- Restart application
- Install plans instead of just checking
- Update to latest app version (includes plan TTL fix)

**Prevention**:
- Install plans or they'll expire anyway
- Restart app daily if many checks

---

## Quick Diagnostic Commands

### Check userData Directory
```bash
# Linux
ls -la ~/.config/AeroSync\ Addon\ Updater/

# Windows (PowerShell)
dir $env:APPDATA\AeroSync Addon Updater\
```

### Validate profiles.json
```bash
# Linux/Mac
jq . ~/.config/AeroSync\ Addon\ Updater/profiles.json

# Windows (with jq installed)
jq . %APPDATA%\AeroSync Addon Updater\profiles.json
```

### Check Temp Files
```bash
# Linux/Mac
ls -lh $(node -e "console.log(require('os').tmpdir())")/updater-*.tmp

# Windows
dir %TEMP%\updater-*.tmp
```

### Test Network Connectivity
```bash
# Test update server reachability
curl -I https://update.x-plane.org

# With auth (replace with your creds)
curl -u "login:licensekey" https://update.x-plane.org/aircrafts/list
```

## Error Code Reference

| Error Message | Meaning | Action |
|---------------|---------|--------|
| `Authentication failed (HTTP 401)` | Invalid credentials | Re-enter login/license |
| `Request timeout after {ms}ms` | Network too slow | Check connection |
| `Invalid JSON response` | Server error | Retry later |
| `Checksum mismatch` | Download corrupted | Retry or repair mode |
| `Update plan not found` | Plan expired | Run check again |
| `Installation cancelled by user` | User clicked cancel | Expected behavior |
| `Unsafe file path from server` | Security check failed | Report to developer |
| `Profile requires: name, productDir` | Missing required fields | Fill in all fields |
| `Plan does not belong to selected profile` | Profile switched | Check correct profile |

## Escalation Path

### Level 1: User Self-Service
- Check this playbook
- Try basic solutions
- Export diagnostics (Actions → Export Diagnostics)

### Level 2: Community Support
- Search GitHub Issues for similar problems
- Post new issue with:
  - Application version
  - Operating system
  - Steps to reproduce
  - Exported diagnostics file

### Level 3: Developer Investigation
- Provide log files
- Describe expected vs actual behavior
- Include network/system environment details

## Preventive Maintenance

### Weekly
- Export profiles backup
- Clear temp directory
- Check disk space

### Monthly
- Update to latest app version
- Review ignored files list
- Clean old downloaded packages

### Per Major Update
- Read release notes
- Export diagnostics before updating
- Test on non-critical profile first
