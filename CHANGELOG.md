# Changelog

All notable public changes to this integration kit are recorded here.

## [v0.1.0-rc.1]

### Added

- Docker Cloud API/SDK sandbox provider integration.
- Owner-scoped managed-image selection and exact external image identities.
- Authenticated HTTPS ingress through a single published proxy port with HTTP and supported WebSocket forwarding.
- Exclusive persistent workspace-volume support at `/workspace`.
- Stop-on-expiration lifecycle with deadline-based renewal and no automatic resume.
- Image/resource compatibility checks that reject CPU/RAM mismatches.
- Isolated Docker Cloud image builder with private image registration and temporary-builder cleanup.
- Public architecture, deployment, compatibility, production-readiness, security, contribution, and notice documentation.

### Verification

- 27 focused tests passed.
- Production API typecheck passed.
- SDK gates passed.
- Prior runtime validation covered health and desktop HTTP 200 responses, CLI/Git/Python/agent-browser/desktop availability, authentication ingress rejection, stop/resume workspace continuity, non-waking renewal for stopped sandboxes, and cleanup.

### Known limitations

- OpenRouter inference, GUI/browser interaction, adversarial review, and load testing were not verified for this release.
- Always-on monitor/app workloads, residential proxies, guaranteed regions, and advanced drive options are unavailable or intentionally rejected.
- This release makes no claim of equal latency, certification, full parity, Docker-based hosted SaaS rights, or license bypass.

[Unreleased]: https://github.com/Hackstar1337/kortix-docker-cloud/compare/v0.1.0-rc.1...HEAD
