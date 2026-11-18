# Security boundaries and release hardening

This release is intended for self-hosted, trusted-workload evaluation. It is **not a hardened hostile-guest or multi-tenant hosting platform**. Docker supplies the cloud sandbox isolation; this adapter does not independently certify that boundary.

## Guest-root limitation

The ingress proxy and workload share the guest. The proxy's edge key resides in a guest-root-readable file, and a root workload can replace the proxy, read its key, or bind its port. The unauthenticated readiness probe is not an attestation against a malicious guest listener. File permissions do not isolate a credential from guest root. Use trusted workloads only; hostile guest support requires a separately trusted control-plane/sidecar ingress implementation and additional verification. The Docker management PAT and backend signing key remain outside the guest, but the derived ingress key is inside it.

## Checks added for this public release

Direct managed image IDs must resolve to this deployment's ownership-derived display-name prefix before launch or state inspection. Existing volume IDs must resolve to the exact deployment/logical-sandbox-derived workspace name. These are defenses against ordinary application callers, not against an operator possessing the Docker management credential who can create or rename provider resources.

Failed builder cleanup independently attempts to erase its temporary registry upload credential before deleting the builder. Transfer setup is inside the cleanup scope, including partial directory setup failure. Provider cleanup remains best effort during network/API outages; its bounded timeout is a backstop, not proof that cleanup completed.

## Retained workspaces and failed creation

Create/wait failures retain the independent workspace because an ambiguous request may have succeeded and a retry may refer to existing user bytes. The original SDK error retains its classification and carries `dockerCloudRetainedWorkspace` with the volume, ownership-derived workspace name and logical identity for private operator reconciliation. Do not publish that runtime metadata.

There is no automatic retained-volume deletion or volume orphan reaper in this release. Operators must inventory retained storage, verify its deployment/logical ownership and attachment state, establish whether it contains required user files, and obtain the appropriate deletion authorization before removing it. Storage costs can continue after sandbox stop/delete or failed creation. Never infer that a missing application row authorizes deleting provider storage.

## Evidence boundary

Prior instance testing verified the core real runtime and lifecycle. The additional public-release ownership and cleanup hardening is validated by focused regression tests and source/patch checks; it does not retroactively establish full live, adversarial, GUI or model-inference verification of this release. Review [production readiness](production-readiness.md) before any deployment.
