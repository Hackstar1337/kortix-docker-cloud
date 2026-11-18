# Production readiness

> **Modification notice:** This release contains modifications to the upstream Kortix CompanyOS source. The Elastic License 2.0 and upstream notices remain mandatory; see [`../LICENSE`](../LICENSE) and [`../NOTICE.md`](../NOTICE.md).

## Release position

`v0.1.0-rc.1` is a **production candidate**, not a certification. It is suitable for controlled evaluation and an operator-managed rollout when the deployment owner accepts the documented capability boundaries and completes environment-specific acceptance testing.

This release does not claim Docker-based hosted SaaS rights, license bypass, equal latency, certification, guaranteed regions, or full parity with upstream or Platinum capabilities.

## Evidence available

The release evidence includes:

- 32 focused Bun contract tests passed, including ownership and builder-cleanup hardening.
- 21 offline repository, installer and deployment-safety tests passed.
- Hardened production API typecheck passed against the matched isolated dependency image.
- SDK gates passed for the prior core integration; public-release hardening does not alter SDK types.
- Prior runtime validation of HTTP 200 health and desktop endpoints.
- Prior runtime validation of CLI, Git, Python, agent-browser, and desktop availability.
- Prior validation that unauthenticated ingress is rejected.
- Prior validation that stop/resume preserves the same sandbox’s workspace continuity.
- Prior validation that renewal does not wake a stopped sandbox.
- Prior validation of successful cleanup.

The evidence does not include a passed OpenRouter inference test, GUI/browser interaction test, adversarial review, or load/soak test. A Docker build or full production-source CI result should not be described as passed unless the corresponding evidence is recorded independently.

## Readiness gates

Before a production rollout, the operator should confirm all of the following:

- The exact upstream revision and patch hash match `integration.json`.
- The image digest is recorded and the image matches requested CPU/RAM.
- CloudPAT is available only to the backend through a private environment file.
- No management credential is present in source, image layers, build context, task environments, logs, or public artifacts.
- The deployment plan was reviewed before apply and the updater-stop confirmation was intentional.
- Health and desktop HTTP checks pass through the authenticated HTTPS ingress path.
- An unauthenticated request is rejected and no raw application port is published.
- Stop, resume, expiration, renewal, and workspace retention behavior are accepted for the target workload.
- The deployment owner has a private backup and rollback procedure.
- Load, adversarial, browser, and inference acceptance tests are complete if the deployment depends on them.
- The organization has reviewed the Elastic License 2.0 and the upstream white-label requirement with appropriate counsel.

## Risk register

| Risk | Current control | Remaining action |
| --- | --- | --- |
| Provider or network interruption | Bounded SDK calls, provider timeout, plan-first rollout | Define environment-specific retry and incident policy. |
| Ingress bypass | Only port `18080` is publishable; raw ports are rejected; HMAC token required | Re-test perimeter controls in the target network. |
| Credential exposure | Backend-only secret handling; isolated builder auth file; sanitized errors | Audit deployment secret injection and log retention. |
| Image mismatch | Exact completed image lookup and CPU/RAM equality check | Record and enforce approved image digests. |
| Data loss during lifecycle changes | Independent workspace volume retained after sandbox deletion | Test backup/restore and retention policy for the workload. |
| Unsupported workload assumptions | Monitors, app always-on, region, residential proxy, and advanced drives are rejected | Route those workloads to a provider with explicit support. |
| Unmeasured performance | No load/soak or equal-latency claim | Run workload-specific capacity and latency testing. |
| Unverified product paths | OpenRouter and GUI/browser flows not verified | Complete acceptance tests before depending on them. |

## Operational recommendation

Begin with a small, observable canary using non-sensitive data and a prepared image whose digest is recorded. Monitor health, ingress rejection, expiration, renewal, stop/resume, workspace continuity, and cleanup. Expand only after environment-specific load and security review are complete.

The release is not ready for a claim of universal production parity. It is ready for controlled deployment only within the documented provider contract and licensing boundaries.


## Public-release security and validation scope

Guest root is explicitly trusted in this release. A malicious root guest can read the derived ingress credential or replace the listener; the unauthenticated probe is not trusted attestation. See [security boundaries](security-boundaries.md). Do not deploy this candidate as a hostile-guest or multi-tenant hosting service.

The sanitized [validation record](../validation.json) separates current local source/contract checks from prior real-runtime evidence and GitHub's server-side CI. Public-release hardening has not been separately certified through live cloud, GUI, model-inference or load/soak testing. The manual full-source API build workflow is supplied, not claimed to have passed merely because it exists.
