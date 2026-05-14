# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in Stavr, please email
**stenlund@gmail.com** directly rather than opening a public GitHub issue.

Include in your report:

- A description of the issue and its impact
- Steps to reproduce, if applicable
- The affected version (commit SHA or release tag)
- Your suggested remediation, if you have one

We aim to acknowledge reports within 72 hours and to ship a fix or
workaround within 14 days for high-severity issues. Lower-severity
issues are scheduled into the normal release cadence.

## Supported Versions

Stavr is pre-1.0 software. Security issues are patched on the latest
tagged release. Older versions are not supported.

## Scope

Stavr's daemon binds to `127.0.0.1` only by design (see [ADR-006](adr/006-daemon-binds-127001-only.md)).
Issues that require deliberately exposing the daemon to a wider network
surface are out of scope — don't do that. Issues affecting the default
local-only configuration are in scope.

## Responsible Disclosure

We don't have a bug bounty program. We do try to credit reporters in
the release notes for the fix unless you ask us not to.
