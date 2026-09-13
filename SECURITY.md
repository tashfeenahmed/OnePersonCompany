# Security

One Person Company is a self-hosted, single-owner application. The maintained
branch is `main`. Keep your installation current and read the
[security model](docs/security.md) and [deployment guide](docs/deployment.md)
before granting agent access or exposing an installation beyond loopback.

## Report a vulnerability privately

If GitHub offers **Security → Report a vulnerability** on this repository, use
that private reporting flow. Include the affected revision, reproduction steps,
impact, and a minimal example using fictional data.

If private reporting is unavailable, open an issue that only requests a private
contact channel. Do not include exploit instructions, credentials, personal
information, private service URLs, or customer data in that public issue.

Do not test against another person's installation or production data. There is
no published response-time guarantee or bug-bounty program.

## Protect your installation

The local data directory and full backups contain sensitive material, including
the vault key. A preferences export does not replace a full backup. Cloud models
and connected APIs receive the data required by the operations you choose.

See [the security guide](docs/security.md) for owner and agent keys, browser
checks, session controls, and OS-user isolation. Report suspected credential
exposure privately and revoke affected credentials with their providers.
