# Architecture

> **Modification notice:** This document describes a modified integration of the upstream Kortix CompanyOS source. Preserve the upstream notices and the Elastic License 2.0 in [`../LICENSE`](../LICENSE).

## Scope

Kortix Docker Cloud is an API/SDK provider integration. The backend selects the `docker-cloud` provider through the existing sandbox provider contract; it does not rebuild the GUI provider picker. The integration uses `@docker/sandboxes` `0.53.0` and the Bun toolchain declared by [`../integration.json`](../integration.json).

The source baseline is `kortix-ai/CompanyOS` revision `1f58c106d02140c4b050c539904d9410b438ab5f`. The patch and file hashes in `integration.json` are the reproducibility boundary for this release.

## Component map

```text
Kortix API / SDK
       |
       | provider contract: create, start, stop, remove, exec, ingress
       v
DockerCloudProvider
       |
       +--> Docker Cloud SDK client (@docker/sandboxes)
       |       +--> sandbox lifecycle
       |       +--> managed image lookup
       |       +--> exclusive workspace volume
       |       +--> one published ingress port
       |
       +--> guest ingress proxy (Bun or standalone Linux binary)
       |       +--> token validation
       |       +--> target-port validation
       |       +--> HTTP / WebSocket forwarding
       |
       +--> isolated image builder
               +--> staged context upload
               +--> Docker build inside a temporary builder
               +--> private managed-image registration
```

## Sandbox creation

1. The provider validates the logical sandbox identity and workload credential.
2. Unsupported requirements are rejected before provider allocation: persistent monitor workloads, region guarantees, residential-proxy routing, more than one volume, non-`/workspace` mounts, and Platinum-specific mount options.
3. The provider resolves an exact completed managed image. A named image is resolved through the owner-scoped display name; an `images/...` identity is resolved directly.
4. If no volume is supplied, the provider creates one with an idempotency key. A supplied volume must be native, exclusive, and mounted only at `/workspace`.
5. The sandbox is created with the configured lifetime, `onTimeout: stop`, and `autoResume: false`. Ownership, logical ID, and workload labels bind the resource to the Kortix deployment.
6. The provider waits for the sandbox to run, confirms the effective timeout and volume attachment, installs the private ingress proxy, and publishes only the dedicated ingress port.
7. The provider returns an HTTPS endpoint plus internal routing metadata. Ambiguous create/wait failures are reconciled through idempotency and provider timeout rather than deleting an unknown accepted resource.

CPU and memory are properties of the prepared image. A request with a different CPU or RAM specification is rejected rather than silently resized.

## Authenticated ingress

The guest proxy listens on port `18080`. Only this port may be published. A raw application port causes provider adoption to fail because it would bypass authentication.

Each request must include:

- `x-kortix-docker-cloud-token` — an HMAC-derived per-owner/per-logical-sandbox token.
- `x-kortix-docker-cloud-port` — a decimal target port other than `18080`.

The proxy compares tokens in constant time, validates the target port, strips hop-by-hop and routing headers before forwarding, and uses HTTP for ordinary requests. Supported WebSocket upgrades are translated to the local `ws:` target, with bounded queue and payload limits. Unauthorized requests return `401`; invalid target ports return `400`; an unavailable application returns `502`.

The public endpoint must be HTTPS. The proxy never forwards the management token or other provider credentials into the workload. The proxy source is written to a private directory with restrictive permissions and runs as a dedicated process session.

PTY and application WebSocket routing is handled by the provider contract. PTY traffic targets port `8000`; WebSocket requests carry the provider’s user-context query parameter, and PTY routes default the cursor to `0`.

## Lifecycle and ownership

The provider maps Docker Cloud states as follows:

| Docker Cloud state | Kortix state |
| --- | --- |
| `running` | `running` |
| `stopped` | `stopped` |
| `failed` | `terminal` |
| `deleted` | `removed` |

Renewal is deadline-based: only a running sandbox whose expiration is within the configured threshold is renewed. Renewal sets a fresh lifetime; it does not add time to an old deadline, and it never wakes a stopped sandbox. Stop and start wait for provider confirmation. Remove waits for deletion but deliberately retains the independent workspace volume so user files survive sandbox removal.

Every resource lookup verifies deployment ownership labels. Managed-running enumeration is limited to resources with the current owner marker. This prevents an unrelated Docker Cloud resource from being adopted by the provider.

## Image building

The builder stages the exact runtime context, archives it, and uploads it to an isolated temporary shell builder. The Docker build runs inside that builder on `linux/amd64`. The host Docker socket, registry password, and Cloud management token do not enter the builder.

A temporary private registry credential is written only to an isolated Docker configuration directory in the builder, used for the image push, and removed. The temporary builder has a delete-on-timeout lifecycle and is deleted after the image is registered. The provider polls for a completed managed image and requires a digest before returning its exact external template identity. Incomplete image registrations and temporary local archives are cleaned up on failure.

Region-pinned image builds are rejected. An image or Dockerfile is required, and the resulting runtime profile determines whether the shared Kortix entrypoint or a supplied application entrypoint is used.

## Failure containment

- Provider calls use bounded SDK timeouts.
- Creation uses idempotency keys derived from owner, logical sandbox ID, and attempt.
- A bootstrap failure stops the running sandbox but does not delete an independent workspace volume.
- Expiration is a provider-side stop backstop; the existing Kortix deadline/reaper remains authoritative.
- Public raw ports are refused, preventing ingress-proxy bypass.
- Credentials and signed provider URLs are excluded from error messages and build logs.

This design improves isolation and cleanup behavior, but it is not a claim of parity with every upstream or Platinum capability. See [`compatibility.md`](compatibility.md).
