# Contributing

> **Modification notice:** Contributions modify an integration built from upstream Kortix CompanyOS. Preserve the Elastic License 2.0, copyright notices, and the prominent modifications notice in redistributed copies.

Thank you for improving Kortix Docker Cloud. This repository is an independent integration kit; contributions should stay within its documented API/SDK provider scope and must not imply upstream endorsement or commercial rights.

## Before you change code

- Read [`README.md`](README.md), [`docs/architecture.md`](docs/architecture.md), and [`docs/compatibility.md`](docs/compatibility.md).
- Treat `integration.json` as the source of truth for the pinned upstream revision, runtime versions, patch, and integrity metadata.
- Do not edit parent-owned scripts, CI, tests, manifests, or overlay files as part of documentation-only work unless the change is explicitly authorized by the repository owner.
- Never add credentials, private environment files, local machine paths, account/project/session/sandbox identifiers, private timestamps, raw logs, or backup artifacts.

## Changes we welcome

- Public documentation that is accurate, compact, and reproducible.
- Provider contract fixes with focused tests and a compatibility note.
- Security hardening for ownership checks, ingress authentication, secret handling, lifecycle idempotency, or cleanup.
- Improvements that preserve the single authenticated ingress boundary and independent workspace-volume semantics.

Do not add a GUI provider picker in this integration as a substitute for the API/SDK provider path. Do not weaken rejection of raw ports, management credentials in workloads, unsupported region/residential-proxy requests, or mismatched image resources.

## Local verification

Use the repository’s public verification entry points:

```bash
python scripts/prepare.py --target .work/upstream
bash scripts/test-contract.sh .work/upstream
python scripts/verify.py
python -m unittest discover -s tests -v
bash scripts/build.sh .work/upstream kortix-api-docker-cloud:local
```

Use `python scripts/deploy.py --help` to inspect deployment options. Do not apply a deployment from a contribution branch without an explicit operator decision.

A contribution must not claim a Docker build, full production-source CI, OpenRouter inference, GUI/browser interaction, adversarial review, or load testing passed unless the corresponding evidence is included and independently reproducible.

## Pull requests

A useful pull request includes:

1. A concise problem statement and scope.
2. The provider behavior or documentation boundary that changes.
3. Tests or verification commands run, with honest results.
4. Compatibility and security implications.
5. Any new operational or licensing limitation.

Keep changes reviewable. Prefer one behavior or documentation topic per pull request. For provider changes, include failure-path tests for rejected credentials, raw ports, ownership mismatches, invalid target ports, image/resource mismatches, and cleanup where applicable.

## Documentation standards

Write for public operators. Use relative links, neutral claims, and explicit status labels such as **Verified**, **Rejected**, or **Not verified**. Never copy private runbooks or validation artifacts into public documentation. Keep the upstream Elastic License 2.0 and the white-label/exclusive-Platinum boundary prominent.

## Upstream changes

Updating the upstream revision is a release-level change. It requires a new pinned revision, refreshed patch/integrity metadata, a compatibility review, and re-running the relevant contract and SDK gates. Do not silently replace the pinned source or describe an unverified upstream change as equivalent.
