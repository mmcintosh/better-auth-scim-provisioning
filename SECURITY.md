# Security

Please report vulnerabilities privately, through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue.

Include what you found, how to reproduce it, and what it affects. I aim to acknowledge a report within **7 days**, then work on a fix and agree on a disclosure date with you. You'll be credited in the release notes unless you'd rather not be named. A fixed vulnerability is announced in a GitHub security advisory and in the CHANGELOG's Security section for that release.

Supported: the latest release.

## How releases are protected

- Published only from CI, with npm trusted publishing: each version carries SLSA provenance, and the GitHub release has a Sigstore bundle and a CycloneDX SBOM.
- Every version is staged and approved by the maintainer before it can be installed.
- Every GitHub Action is pinned by SHA; CodeQL, dependency audits, dependency review, OSV-Scanner and OpenSSF Scorecard run on the repository.
