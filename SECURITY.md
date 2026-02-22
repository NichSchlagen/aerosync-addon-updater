# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Older releases | ❌ |

Only the latest published release receives security fixes. Please update to the
most recent version before reporting an issue.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please use
[GitHub Private Vulnerability Reporting](https://github.com/NichSchlagen/aerosync-addon-updater/security/advisories/new)
to submit your report confidentially.

### What to include

- A clear description of the vulnerability.
- Steps to reproduce or a proof-of-concept (if possible).
- The version(s) affected.
- Any potential impact you have identified.

### What qualifies as a security issue

- Credential or token leakage (Shopify auth, iniBuilds tokens, stored passwords).
- Path traversal or arbitrary file write/read via server-supplied paths.
- Bypass of checksum verification (MD5, CRC32).
- IPC input validation bypasses.
- Insecure handling of `safeStorage` or persisted credentials.
- Remote code execution or privilege escalation.

### Response

- You will receive an acknowledgment within **7 days**.
- A fix or mitigation will be targeted within **30 days**, depending on severity.
- You will be credited in the release notes unless you prefer to remain anonymous.

## General Security Design

For details on how AeroSync handles credentials, file integrity, and local
storage, see [docs/data-and-security.md](docs/data-and-security.md).
