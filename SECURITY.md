# Security policy

> **Modification notice:** This repository modifies upstream Kortix CompanyOS source. Keep [`LICENSE`](LICENSE), [`UPSTREAM-WHITE-LABEL-LICENSE.md`](UPSTREAM-WHITE-LABEL-LICENSE.md), and this notice with redistributed copies.

## Security scope

This policy covers the Docker Cloud integration, its authenticated ingress proxy, image-builder path, lifecycle handling, and public deployment documentation. It does not make a security or compliance certification claim for Docker Cloud, Kortix, Platinum, an operator’s network, or an end-user workload.

## Trust boundaries

- The Kortix backend is the control plane and holds the Docker Cloud management credential.
- Docker Cloud is the provider boundary for sandboxes, managed images, ports, and volumes.
- The guest sandbox is a workload boundary and must not receive Cloud management credentials.
- The ingress proxy is the only intended public-to-guest route.
- The workspace volume is independent persistent data and survives sandbox deletion by design.
- The isolated image builder receives staged build material, not a host Docker socket or operator Cloud token.

## Controls

### Credential handling

CloudPAT belongs only in the private backend environment. Never commit it, bake it into an image, place it in a Dockerfile or staged context, inject it into task environments, or include it in logs, issues, screenshots, or documentation. Temporary image-upload credentials are scoped to the private builder Docker configuration and removed after the push.

Errors and build output must not expose registry credentials, signed provider URLs, raw provider requests, or other secret-bearing material.

### Ingress authentication

The provider publishes only the dedicated ingress port `18080`. The guest proxy requires `x-kortix-docker-cloud-token` and compares it in constant time. It separately validates `x-kortix-docker-cloud-port`, refuses invalid or proxy-self-targeting ports, removes hop-by-hop and routing headers, and returns `401`, `400`, or `502` for the corresponding failure classes.

The endpoint must be HTTPS. A raw published application port is rejected because it would bypass the proxy. WebSocket upgrades are bounded and target only validated local ports.

### Resource ownership

Resources carry deployment ownership and logical sandbox labels. Provider lookups verify the current owner marker and a logical ID before operating on a sandbox. Logical and direct external image lookups must match the deployment-derived ownership prefix. Existing workspace references must match the exact deployment/logical-sandbox-derived name before attachment.

### Lifecycle and cleanup

Creation uses idempotency keys. The provider confirms effective stop-on-expiration, disabled automatic resume, and required volume attachment before returning readiness. Bootstrap failures stop running compute while retaining independent workspace data. Remove waits for provider deletion but intentionally does not delete the workspace volume.

The provider uses bounded waits and a provider-side expiration backstop. Operators must reconcile ambiguous operations rather than blindly retrying a create or delete.

## Reporting a vulnerability

Please do not disclose credentials, private logs, personal data, instance identifiers, or exploit details in a public issue. Use GitHub’s private vulnerability reporting or Security Advisory flow for `Hackstar1337/kortix-docker-cloud` when enabled. If private reporting is unavailable, open a minimal public issue asking for a private reporting channel and omit sensitive details.

Include the affected release or commit, a concise impact description, reproduction steps that use synthetic data, and any suggested mitigation. Allow maintainers reasonable time to investigate before public disclosure.

## Operator responsibilities

Operators remain responsible for network policy, identity and access management, image provenance, dependency updates, backups, workload isolation, data retention, incident response, and legal licensing review. This integration does not grant hosted-service rights or bypass the upstream Elastic License 2.0 limitations.


## Public-release trust boundary

Guest root is trusted in this release. Its filesystem contains the derived ingress credential, and the readiness probe is not an attestation against a malicious local listener. See [security boundaries](docs/security-boundaries.md) for the supported threat model, public-release ownership/cleanup hardening, and retained-volume reconciliation requirements. A separately trusted ingress tier is required before hostile-guest or multi-tenant deployment.

Report vulnerabilities through GitHub's **Security → Report a vulnerability** where available. Do not open public issues containing credentials, exploit details or private runtime identifiers.
