# Deployment

> **Modification notice:** This guide applies to the modified upstream source in this repository. Keep [`../LICENSE`](../LICENSE) and the upstream notices with every distribution.

This guide documents the public deployment path for release `v0.1.0-rc.1`. It intentionally omits instance-specific paths, identifiers, timestamps, logs, credentials, and private validation runbooks.

## Prerequisites

- A clean checkout of this repository.
- Python 3 for the repository scripts.
- Bash and the toolchain required by the prepared upstream source.
- Docker access for the image build path.
- A Docker Cloud project and a Cloud personal access token (CloudPAT) supplied to the backend through a private environment file.
- An image or Dockerfile that has been prepared for the target runtime profile.

CloudPAT is a management credential. It belongs only in the private backend environment. Do not put it in a Dockerfile, image layer, staged build context, client-side environment, task sandbox, shell history, logs, or public documentation. Provider management credentials must never be copied into a workload environment.

## Prepare and verify

Prepare the exact pinned upstream source and apply the repository patch:

```bash
python scripts/prepare.py --target .work/upstream
```

Run the focused contract suite against that prepared source:

```bash
bash scripts/test-contract.sh .work/upstream
```

Run repository verification and the Python tests:

```bash
python scripts/verify.py
python -m unittest discover -s tests -v
```

These commands validate the integration contract. They do not, by themselves, prove that a full production Docker build, OpenRouter inference path, GUI/browser interaction, adversarial review, or load test has passed.

## Build the API image

Build from the prepared source and use a deliberately named local image reference:

```bash
bash scripts/build.sh .work/upstream kortix-api-docker-cloud:local
```

The image build path should be treated as a release input: record the source revision, patch integrity, image digest, and configuration separately in the operator’s private release system. Do not publish private build logs or environment files.

The provider’s own runtime image builder follows the same boundary: it uploads a staged context to an isolated Docker Cloud builder, builds there, registers a private managed image, requires a completed image with a digest, and removes temporary builder state. It does not use a Windows-host Docker socket or send Cloud management credentials into the builder.

## Plan before apply

Inspect deployment arguments first:

```bash
python scripts/deploy.py --help
```

The deployment script requires an explicit instance directory, project, and image. It plans by default. Review the generated plan for the target image, project, lifecycle behavior, health checks, and rollback inputs before applying.

An apply must be deliberate and must include the script’s stop-updater confirmation:

```text
python scripts/deploy.py ... --apply --stop-updater
```

Use the exact argument form shown by `--help`; do not infer defaults for the instance directory, project, or image. Keep the plan and apply in the same controlled change window.

## Apply and post-deploy checks

A safe operator sequence is:

1. Confirm the source revision and patch hash from `integration.json`.
2. Confirm the target image reference and its digest.
3. Confirm the private backend environment contains CloudPAT and that no secret is present in the image or staged context.
4. Generate and review the plan.
5. Apply only after the plan is approved and the updater-stop confirmation is intentional.
6. Verify the public health endpoint and desktop HTTP endpoint through the authenticated ingress path.
7. Verify an authenticated application request, then verify that an unauthenticated ingress request is rejected.
8. Verify stop/resume retains `/workspace` data and that renewal does not wake a stopped sandbox.
9. Confirm cleanup is complete and that the independent workspace volume is retained according to policy.

Do not treat a successful process-create receipt as proof of readiness. The provider probes the actual proxy listener and validates effective timeout, HTTPS, port publication, ownership labels, and volume attachment.

## Lifecycle defaults

The release defaults are:

- Lifetime: 60 minutes.
- Renewal threshold: 20 minutes remaining.
- Expiration action: stop.
- Automatic resume: disabled.
- Workspace: one exclusive native volume at `/workspace`.
- CPU and RAM: inherited from the prepared image; mismatches are rejected.
- Provider waits: bounded at up to five minutes for startup, stop, and deletion paths.
- Remove behavior: sandbox deletion is awaited; the independent workspace volume is retained.

A stopped sandbox is not renewed or woken by the renewal path. The existing Kortix deadline/reaper remains the authority for deadlines.

## Rollback and recovery

The deployment flow is plan-first and health-gated. Keep the previous known-good image reference and the deployment tool’s private backup/rollback material outside the public repository. If health checks fail:

1. Stop further rollout.
2. Preserve the failed deployment’s private diagnostics without publishing them.
3. Use the tool’s rollback path and private backups as documented by `python scripts/deploy.py --help`.
4. Re-run health and authenticated ingress checks.
5. Do not delete user workspace data as a first response; sandbox deletion and workspace-volume retention are intentionally separate.

A provider timeout is a safety backstop, not proof of successful cleanup. Reconcile provider state before retrying an ambiguous create or delete operation.

## Unsupported deployment assumptions

This integration does not provide always-on monitor/app workloads, residential proxies, guaranteed region placement, advanced drive mount options, or a rebuilt GUI provider picker. It is not a license bypass and does not establish Docker-based hosted SaaS or white-label rights. See [`compatibility.md`](compatibility.md) and [`../UPSTREAM-WHITE-LABEL-LICENSE.md`](../UPSTREAM-WHITE-LABEL-LICENSE.md).


## Explicit planner examples

Run this on the host with Docker/Compose access, using an instance path and project that you verified yourself:

```bash
python3 scripts/deploy.py \
  --instance-dir /path/to/self-host/default \
  --project your-compose-project \
  --image kortix-api-docker-cloud:local
```

This prints a plan and does not change the installation. For an approved apply, add `--credentials /path/to/private/docker-cloud.env --apply --stop-updater`. The stock updater is paused so it cannot silently replace the custom API image. Stop active Cloud sessions before rollback, then use `python3 scripts/deploy.py --rollback /path/to/private/backup`.

The backend callback origin configured by Kortix must be reachable from the cloud runtime over an authenticated, properly secured public HTTPS route. A host-only `localhost` or Docker network name is not reachable from Docker Cloud. Preserve Kortix's existing runtime service-key and signed-context authentication; do not expose an unauthenticated backend just to make callbacks work.

This generic planner's cutover gate is API/container/frontend health, **not** the original private instance's complete runtime parity gate. Operators must complete the staging acceptance checks in [production readiness](production-readiness.md) before applying. The generic helper has offline unit coverage and is not advertised as having cut over arbitrary production installations.
