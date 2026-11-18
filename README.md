# Kortix Docker Cloud

**Independent integration kit for the Docker Cloud sandbox provider**
Release: `v0.1.0-rc.1` · Status: production candidate

> **Trusted workloads only:** The ingress proxy shares the guest with the workload. Guest root can read its derived edge key or replace the listener. This is not a hardened hostile-guest/multi-tenant release. Read [security boundaries](docs/security-boundaries.md) before deployment.

> **Modification notice:** This repository contains modifications to the upstream Kortix CompanyOS source. It is distributed with the upstream Elastic License 2.0 and the notices in [`LICENSE`](LICENSE) must remain with every copy.

Kortix Docker Cloud adds a provider integration for running Kortix sandbox workloads on Docker Cloud through the API/SDK provider path. It is an integration kit, not a replacement for the upstream product and not a claim of upstream white-label authorization.

## Important licensing boundary

The upstream white-label terms require **Platinum as the exclusive compute provider**. This Docker Cloud integration does not grant Docker-based hosted SaaS rights, bypass the Elastic License 2.0, change license-key obligations, or replace a separately signed agreement. Review [`UPSTREAM-WHITE-LABEL-LICENSE.md`](UPSTREAM-WHITE-LABEL-LICENSE.md) and obtain legal advice for your intended distribution model.

This project makes no claim of certification, equal latency, full feature parity, guaranteed regions, or entitlement to any upstream commercial offering.

## What is included

- A Docker Cloud sandbox provider wired through the API/SDK provider contract.
- A token-authenticated guest ingress proxy for HTTP and supported WebSocket traffic, under the trusted-guest model above.
- Managed-image selection by exact external identity or owner-scoped display name.
- A single exclusive persistent workspace volume mounted at `/workspace`.
- Lifecycle handling with stop-on-expiration, explicit stop/start/remove operations, and deadline-based renewal.
- Isolated Docker Cloud image building without sending the host Docker socket or management credentials into the builder.
- Public documentation and contract/verification entry points.

The GUI provider picker is not rebuilt by this kit. Integrators should use the API/SDK provider path for `docker-cloud`.

## Repository map

- [`docs/architecture.md`](docs/architecture.md) — components, request flow, lifecycle, and security boundaries.
- [`docs/deployment.md`](docs/deployment.md) — preparation, build, plan/apply workflow, and operational procedures.
- [`docs/compatibility.md`](docs/compatibility.md) — verified behavior, unsupported capabilities, and items still requiring validation.
- [`docs/production-readiness.md`](docs/production-readiness.md) — evidence, risks, and release gates.
- [`SECURITY.md`](SECURITY.md) — threat model, secret handling, and reporting guidance.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution and documentation rules.
- [`CHANGELOG.md`](CHANGELOG.md) — release history.
- [`NOTICE.md`](NOTICE.md) — upstream and modification notices.
- [`integration.json`](integration.json) — pinned upstream revision and integrity metadata.

## Quickstart

The repository’s scripts are intentionally explicit about source preparation, contract tests, and deployment. Run them from the repository root in an environment with the required toolchain:

```bash
# Prepare a clean upstream checkout and apply the pinned integration patch.
python scripts/prepare.py --target .work/upstream

# Run the isolated provider-focused contract suite.
bash scripts/test-contract.sh .work/upstream

# Run repository verification and the Python test suite.
python scripts/verify.py
python -m unittest discover -s tests -v

# Build the API image from the prepared upstream source.
bash scripts/build.sh .work/upstream kortix-api-docker-cloud:local

# Inspect deployment arguments before making any changes.
python scripts/deploy.py --help
```

`deploy.py` is plan-first. An apply requires an explicit instance directory, project, and image, plus the deliberate updater-stop confirmation described in [`docs/deployment.md`](docs/deployment.md). Do not paste credentials into commands or commit generated environment files.

## Configuration and secrets

The Docker Cloud personal access token (CloudPAT) is a backend-only secret. Provide it through the private deployment environment file used by the backend; never bake it into an image, source archive, client bundle, task sandbox, logs, or public documentation. Provider management credentials are rejected if they enter a workload environment.

The default lifecycle policy is a **60-minute** timeout with renewal when **20 minutes** or less remain. Renewal is deadline-based and does not wake stopped sandboxes. CPU and RAM are inherited from the prepared image; a resource request that does not match the image is rejected. Stop, start, and remove operations use bounded provider waits of up to five minutes. Workspace volumes are independent and retained after sandbox deletion.

## Verification status

The release evidence includes 27 focused tests, production API typechecking, and SDK gates. Prior runtime checks also covered health and desktop HTTP responses, CLI/Git/Python/agent-browser/desktop availability, authentication ingress rejection, stop/resume with workspace continuity, no renewal wake-up for stopped sandboxes, and cleanup.

Open validation items include OpenRouter inference, GUI/browser interaction, adversarial review, and load testing. Always-on monitor/app workloads, residential proxies, guaranteed regions, and advanced drive options are intentionally rejected or unavailable. See [`docs/compatibility.md`](docs/compatibility.md) for the complete matrix.

## Upstream and license

The integration is based on `kortix-ai/CompanyOS` at the exact revision recorded in [`integration.json`](integration.json): `1f58c106d02140c4b050c539904d9410b438ab5f`. The upstream source and this integration remain subject to the Elastic License 2.0. See [`LICENSE`](LICENSE), [`UPSTREAM-WHITE-LABEL-LICENSE.md`](UPSTREAM-WHITE-LABEL-LICENSE.md), and [`NOTICE.md`](NOTICE.md).
