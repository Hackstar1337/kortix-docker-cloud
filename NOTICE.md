# Notices

## Upstream source

This repository is an independent integration kit based on the upstream Kortix CompanyOS repository:

- Repository: <https://github.com/kortix-ai/CompanyOS>
- Pinned revision: `1f58c106d02140c4b050c539904d9410b438ab5f`
- Release: `v0.1.0-rc.1`

The pinned revision, patch path, patch digest, and file hashes are recorded in [`integration.json`](integration.json). Do not treat this integration kit as an unmodified upstream distribution.

## License

The upstream source and modifications are distributed under the Elastic License 2.0 in [`LICENSE`](LICENSE). Every recipient must receive the license terms and existing copyright, licensing, and other notices. Modified copies must include a prominent notice stating that they have been modified.

The upstream white-label terms are reproduced in [`UPSTREAM-WHITE-LABEL-LICENSE.md`](UPSTREAM-WHITE-LABEL-LICENSE.md). Those terms require Platinum as the exclusive compute provider for the covered white-label arrangement. This Docker Cloud integration does not grant Docker-based hosted SaaS rights, bypass the Elastic License 2.0, alter license-key obligations, or substitute for a separately signed agreement.

## Modification notice for distributions

A suitable notice for a redistributed modified copy is:

> This distribution modifies Kortix CompanyOS and adds an independent Docker Cloud sandbox-provider integration. It is not an unmodified upstream release and does not claim upstream certification, equal latency, full feature parity, guaranteed regions, or hosted-service rights.

Retain this notice, [`LICENSE`](LICENSE), [`UPSTREAM-WHITE-LABEL-LICENSE.md`](UPSTREAM-WHITE-LABEL-LICENSE.md), and upstream notices in any public or private redistribution where the applicable license requires them.

## Third-party components

The integration uses the dependencies declared by the prepared upstream source, including Docker’s sandbox SDK as pinned in `integration.json`. Their own licenses and notices remain applicable. Dependency license text should be obtained from the corresponding source distribution rather than copied into this notice without verification.

## No endorsement

Names and marks belonging to Kortix, Docker, Platinum, or other third parties remain the property of their respective owners. This repository does not imply endorsement, certification, partnership, or warranty by those parties.
