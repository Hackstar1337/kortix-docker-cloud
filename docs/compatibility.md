# Compatibility

> **Modification notice:** This is documentation for a modified upstream integration. Preserve [`../LICENSE`](../LICENSE) and all upstream notices.

Compatibility in this document means behavior observed or enforced by the integration, not a claim of full upstream or Platinum parity.

## Verified in prior runtime validation

| Area | Result | Notes |
| --- | --- | --- |
| Health endpoint | Verified | Returned HTTP 200 through the deployment’s public path. |
| Desktop endpoint | Verified | Returned HTTP 200. |
| CLI | Available | CLI path was available in the runtime validation. |
| Git | Available | Git operations were available in the runtime validation. |
| Python | Available | Python execution was available in the runtime validation. |
| agent-browser | Available | The runtime exposed the expected tool. |
| Desktop | Available | Desktop capability was available. |
| Ingress authentication | Verified | Unauthorized ingress was rejected. |
| Stop/resume | Verified | Same sandbox resumed with workspace continuity. |
| Renewal behavior | Verified | Renewal did not wake a stopped sandbox. |
| Cleanup | Verified | Successful cleanup was observed. |
| Focused tests | Passed | 27 focused tests passed. |
| API typecheck | Passed | Production API typecheck passed. |
| SDK gates | Passed | SDK gates passed. |

The evidence above is release evidence, not a service-level guarantee.

## Supported and enforced behavior

| Capability | Status | Boundary |
| --- | --- | --- |
| API/SDK provider selection | Supported | Use the `docker-cloud` provider contract; no GUI picker rebuild is included. |
| Managed image launch | Supported | Requires an exact completed Docker Cloud managed image. |
| CPU/RAM requests | Constrained | Must match the prepared image; mismatches are rejected. |
| Persistent workspace | Supported | One exclusive native volume mounted at `/workspace`. |
| Stop-on-expiration | Supported | Default lifetime is 60 minutes; automatic resume is disabled. |
| Deadline renewal | Supported | Running sandboxes renew near the 20-minute threshold; stopped sandboxes are not woken. |
| HTTP ingress | Supported | HTTPS endpoint through the authenticated proxy and target-port header. |
| WebSocket ingress | Supported | Supported application and PTY routes only; bounded queue/payload behavior applies. |
| Command execution | Supported | Provider process execution with bounded output. |
| Sandbox deletion | Supported | Deletion is awaited; independent workspace volume is retained. |
| Image build | Supported with prerequisites | Isolated Docker Cloud builder; image or Dockerfile required; region-pinned builds rejected. |

## Intentionally rejected or unavailable

| Capability | Status | Reason |
| --- | --- | --- |
| Persistent monitor workloads | Not enabled | Always-on monitor support is not verified; use the upstream-supported path where appropriate. |
| Always-on app workloads | Not enabled | Always-on app support is not verified for this integration. |
| Residential proxies | Rejected | Docker Cloud does not implement Kortix residential-proxy routing. |
| Guaranteed regions | Rejected | The provider cannot guarantee a requested region. |
| Advanced drives | Not supported | The provider accepts only one exclusive native volume at `/workspace`; read-only, subdirectory, reference, and share options are rejected. |
| Raw published application ports | Rejected | Raw ports would bypass the authentication proxy. |
| GUI provider picker | Not rebuilt | Select `docker-cloud` through the API/SDK provider path. |

## Not verified for this release

The following are not represented as passing claims in `v0.1.0-rc.1`:

- OpenRouter inference.
- GUI/browser interaction.
- Adversarial security review.
- Load, soak, or capacity testing.
- Equal latency to any other provider.
- Certification or full feature parity.
- Guaranteed regional placement or availability.

Consumers should make their own acceptance tests for workload types, traffic levels, regions, model providers, and browser flows relevant to their deployment.

## Runtime and dependency pins

The integration metadata declares Docker SDK `0.53.0` and Bun `1.4.4`. The upstream revision and patch digest are recorded in [`../integration.json`](../integration.json). A change to either runtime, the patch, or a provider contract should trigger a fresh compatibility review.
