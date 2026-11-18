import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Sandboxes, Sandbox, ClientCreateOptions } from '@docker/sandboxes';
import { config } from '../../config';
import { sandboxOwnershipMarker } from '../sandbox-ownership';
import { serviceKeyForExternalId } from '../service-key';
import { findDockerCloudImages } from '../../snapshots/providers/docker-cloud-builder';
import {
  assertWorkloadCredential, SandboxTemplateNotFoundError, type SandboxProvider, type CreateSandboxOpts,
  type ProvisionResult, type SandboxStartOptions, type SandboxExecOptions,
  type SandboxExecResult, type SandboxIngressRequest, type ResolvedSandboxIngress,
  type ResolvedEndpoint, type ProvisioningStatus, type SandboxStatus,
} from './contract';
import { isPtyWebSocketPath } from './pty-ingress';
import {
  getDockerCloudClient, dockerCloudExternalId, dockerCloudResourceName, dockerCloudNotFound,
} from './docker-cloud-client';
import {
  DOCKER_CLOUD_INGRESS_PORT, DOCKER_CLOUD_INGRESS_TOKEN_HEADER,
  DOCKER_CLOUD_TARGET_PORT_HEADER, DOCKER_CLOUD_PROXY_SOURCE,
} from './docker-cloud-proxy';
import { uploadDockerCloudFile } from './docker-cloud-transfer';

const CALL_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 300_000;
const PROXY_SESSION = 'kortix-docker-cloud-ingress-v1';
const PROXY_DIR = '/tmp/kortix-docker-cloud';
const OWNER_LABEL = 'kortix.managed';
const LOGICAL_LABEL = 'kortix.logical_id';
const WORKLOAD_LABEL = 'kortix.workload';

export function dockerCloudStatus(status: string): SandboxStatus {
  switch (status) {
    case 'running': return 'running';
    case 'stopped': return 'stopped';
    case 'failed': return 'terminal';
    case 'deleted': return 'removed';
    default: return 'unknown';
  }
}

/** Renewal does not add an hour to the old expiry; it sets time remaining. */
export function dockerCloudRenewalDue(status: string, expiresAt: Date | undefined, now: number, thresholdMs: number): boolean {
  if (status !== 'running') return false;
  if (!expiresAt || !Number.isFinite(expiresAt.getTime())) throw new Error('Docker Cloud did not report a valid expiration deadline.');
  return expiresAt.getTime() - now <= thresholdMs;
}

interface Dependencies {
  client?: Sandboxes;
  owner?: () => Promise<string>;
  signingKey?: () => string;
  serviceKey?: (id: string) => Promise<string | undefined>;
  now?: () => number;
}

/** Keeps Kortix's existing deadline/reaper authoritative; never self-renews in the guest. */
export class DockerCloudProvider implements SandboxProvider {
  readonly name = 'docker-cloud' as const;
  readonly ingressCacheTtlMs = 30_000;
  readonly provisioning = {
    async: false,
    stages: [
      { id: 'image', progress: 10, message: 'Preparing Docker Cloud runtime image' },
      { id: 'creating', progress: 40, message: 'Creating Docker Cloud sandbox' },
      { id: 'runtime', progress: 80, message: 'Connecting authenticated runtime' },
      { id: 'ready', progress: 100, message: 'Docker Cloud sandbox ready' },
    ],
  };
  constructor(private readonly dependencies: Dependencies = {}) {}
  private get client(): Sandboxes { return this.dependencies.client ?? getDockerCloudClient(); }
  private owner(): Promise<string> { return (this.dependencies.owner ?? sandboxOwnershipMarker)(); }
  private now(): number { return (this.dependencies.now ?? Date.now)(); }
  private lifetimeMs(): number {
    const value = config.DOCKER_CLOUD_LIFETIME_MINUTES * 60_000;
    if (!Number.isFinite(value) || value < 60_000) throw new Error('Invalid Docker Cloud lifetime.');
    return value;
  }
  private proxyKey(owner: string, logicalId: string): string {
    return createHmac('sha256', this.dependencies.signingKey?.() ?? config.INTERNAL_SERVICE_KEY)
      .update(JSON.stringify(['kortix-docker-cloud-ingress-v1', owner, logicalId])).digest('hex');
  }
  private async get(externalId: string): Promise<Sandbox> {
    const sandbox = await this.client.get(dockerCloudResourceName(externalId), { timeoutMs: CALL_TIMEOUT_MS });
    const owner = await this.owner();
    if (sandbox.core.labels?.[OWNER_LABEL] !== owner || !sandbox.core.labels?.[LOGICAL_LABEL]) {
      throw new Error('Docker Cloud sandbox does not belong to this Kortix deployment.');
    }
    return sandbox;
  }

  async createFromExternalId(externalTemplateId: string, opts: CreateSandboxOpts): Promise<ProvisionResult> {
    if (!/^images\/[A-Za-z0-9._-]+$/.test(externalTemplateId)) throw new SandboxTemplateNotFoundError('Invalid Docker Cloud image identity.');
    try { return await this.create({ ...opts, snapshot: externalTemplateId }); }
    catch (error) {
      if (dockerCloudNotFound(error)) throw new SandboxTemplateNotFoundError('The cached Docker Cloud image no longer exists.');
      throw error;
    }
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    const envVars = { ...opts.envVars };
    assertWorkloadCredential(this.name, opts, envVars);
    if (!opts.sandboxId) throw new Error('Docker Cloud requires a full logical sandboxId for idempotent creation.');
    if (opts.workloadType === 'monitor') {
      throw new Error('Docker Cloud persistent monitor workloads are not enabled; use Platinum until always-on support is verified.');
    }
    if (opts.locationRequired) throw new Error('Docker Cloud cannot guarantee a requested region; use Platinum for region-bound drives.');
    if (opts.residentialProxy) throw new Error('Docker Cloud does not implement Kortix residential-proxy routing.');
    if (Object.keys(envVars).some((key) => /^DOCKER_CLOUD_(PAT|USERNAME)$/.test(key))) {
      throw new Error('Docker Cloud management credentials must not enter a task sandbox.');
    }
    const entries = Object.entries(opts.volumes ?? {});
    if (entries.length > 1) throw new Error('Docker Cloud currently supports one exclusively attached volume per sandbox.');
    for (const [path, attachment] of entries) {
      if (path !== '/workspace') throw new Error('Docker Cloud requires its sole persistent volume at /workspace.');
      if (!/^volumes\/[A-Za-z0-9._-]+$/.test(attachment.volume) || attachment.read_only || attachment.subdir || attachment.ref || attachment.share) {
        throw new Error('Docker Cloud requires a native exclusive volume without Platinum-specific mount options.');
      }
    }
    const image = opts.snapshot ?? config.DOCKER_CLOUD_IMAGE;
    if (!image) throw new Error('No project runtime image is ready for Docker Cloud.');
    const images = await findDockerCloudImages(image, this.client);
    const ready = images.filter((candidate) => candidate.status === 'completed').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!ready) throw new SandboxTemplateNotFoundError('The exact Docker Cloud project image is not ready.');
    if (opts.resourceSpec && (ready.resources?.cpus !== opts.resourceSpec.cpuCores || ready.resources?.memoryMib !== opts.resourceSpec.memoryGb * 1024)) {
      throw new Error('Docker Cloud CPU/RAM are fixed by the prepared image; build a matching resource-size template before creating this sandbox.');
    }
    const owner = await this.owner();
    const workspaceName = `kortix-workspace-${createHmac('sha256', owner).update(opts.sandboxId).digest('hex')}`;
    if (entries.length) {
      const existing = await this.client.volumes.get(entries[0]![1].volume, { timeoutMs: CALL_TIMEOUT_MS });
      if (existing.displayName !== workspaceName) {
        throw new Error('Docker Cloud workspace volume is not bound to this deployment and logical sandbox.');
      }
    }
    const volume = entries.length ? undefined : await this.client.volumes.create(
      { displayName: workspaceName },
      { timeoutMs: CALL_TIMEOUT_MS, idempotencyKey: `kortix-dc-volume-${owner}-${opts.sandboxId}` },
    );
    const volumeName = entries[0]?.[1].volume ?? volume!.name;
    const mountPath = entries[0]?.[0] ?? '/workspace';
    const input: ClientCreateOptions = {
      displayName: opts.name,
      image: ready.name,
      environment: envVars,
      lifecycle: { timeoutMs: this.lifetimeMs(), onTimeout: 'stop', autoResume: false },
      storage: { volumes: [{ volume: volumeName, target: mountPath, mode: 'exclusive' }] },
      labels: { [OWNER_LABEL]: owner, [LOGICAL_LABEL]: opts.sandboxId, [WORKLOAD_LABEL]: opts.workloadType ?? 'session' },
    };
    let sandbox: Sandbox;
    try {
      sandbox = await this.client.create(input, {
        timeoutMs: START_TIMEOUT_MS,
        idempotencyKey: `kortix-dc-create-${owner}-${opts.sandboxId}-${opts.createAttempt ?? 0}`,
      });
      sandbox = await sandbox.waitUntilRunning({ timeoutMs: START_TIMEOUT_MS });
    } catch (error) {
      // Retain potentially accepted storage rather than deleting user bytes on an ambiguous retry.
      // Expose a reconciliation handle without changing the SDK error classification.
      if (error instanceof Error) Object.assign(error, { dockerCloudRetainedWorkspace: { volumeName, workspaceName, logicalId: opts.sandboxId } });
      throw error;
    }
    const effective = sandbox.effectiveFeatures;
    if (effective?.timeouts?.onTimeout !== 'stop' || !effective.timeouts.expiresAt || effective.timeouts.autoResume) {
      await (await sandbox.stop({ timeoutMs: CALL_TIMEOUT_MS })).waitUntilStopped({ timeoutMs: 60_000 });
      throw new Error('Docker Cloud did not honor stop-on-expiration without automatic resume.');
    }
    if (!effective.managedVolumes?.attachments?.some((a) => a.volume === volumeName && a.target === mountPath)) {
      await (await sandbox.stop({ timeoutMs: CALL_TIMEOUT_MS })).waitUntilStopped({ timeoutMs: 60_000 });
      throw new Error('Docker Cloud did not attach the required workspace volume.');
    }
    try {
      await this.ensureProxy(sandbox);
      const port = await this.publishedProxy(sandbox);
      return {
        externalId: dockerCloudExternalId(sandbox.name), baseUrl: this.validPortUrl(port),
        metadata: {
          provider: this.name, volumeName, volumeMountPath: mountPath,
          expiresAt: effective.timeouts.expiresAt.toISOString(), image: ready.name, requestedSnapshot: image,
          cpuCores: sandbox.core.resources?.cpus, memoryGb: Number(sandbox.core.resources?.memoryMib ?? 4096) / 1024,
          requestedDiskGb: opts.resourceSpec?.diskGb,
        },
      };
    } catch (error) {
      // A definite bootstrap failure must not leave paid compute running.
      // Retain the independent volume; it may contain user files.
      try { await (await (await this.client.get(sandbox.name)).stop({ timeoutMs: CALL_TIMEOUT_MS })).waitUntilStopped({ timeoutMs: 60_000 }); }
      catch { /* Provider timeout remains the safety backstop; caller records provisioning failure. */ }
      throw error;
    }
  }

  private async ensureProxy(sandbox: Sandbox): Promise<void> {
    const check = await sandbox.processes.run({ args: ['/bin/sh', '-c', `mkdir -p ${PROXY_DIR} && chmod 700 ${PROXY_DIR}`], user: 'root' }, { timeoutMs: CALL_TIMEOUT_MS });
    if (check.exitCode !== 0 || check.incomplete) throw new Error('Unable to initialize private Docker Cloud ingress directory.');
    const labels = sandbox.core.labels ?? {};
    await sandbox.files.write(`${PROXY_DIR}/ingress-key`, this.proxyKey(labels[OWNER_LABEL], labels[LOGICAL_LABEL]), {}, { timeoutMs: CALL_TIMEOUT_MS });
    const processes = await sandbox.processes.all({}, { timeoutMs: CALL_TIMEOUT_MS, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }).collect();
    if (processes.some((p) => (p.session === PROXY_SESSION || p.session?.startsWith(`${PROXY_SESSION}-`)) && p.state === 'running')) return;
    const bun = await sandbox.processes.run({ args: ['/bin/sh', '-c', 'command -v bun || true'], user: 'root' }, { timeoutMs: CALL_TIMEOUT_MS });
    let argv: string[];
    if (bun.exitCode === 0 && /^\/[A-Za-z0-9_./-]+$/.test(bun.stdout.trim())) {
      await sandbox.files.write(`${PROXY_DIR}/proxy.ts`, DOCKER_CLOUD_PROXY_SOURCE, {}, { timeoutMs: CALL_TIMEOUT_MS });
      argv = [bun.stdout.trim(), `${PROXY_DIR}/proxy.ts`];
    } else {
      // App images need no Bun installation: the API image ships a standalone Linux executable.
      const binary = await readFile(new URL('../../../dist/docker-cloud-ingress', import.meta.url));
      await uploadDockerCloudFile(sandbox, `${PROXY_DIR}/proxy`, binary, { timeoutMs: START_TIMEOUT_MS, executable: true });
      argv = [`${PROXY_DIR}/proxy`];
    }
    const identity = `${PROXY_SESSION}-${randomUUID()}`;
    await sandbox.processes.start({ args: argv, user: 'root', session: identity, label: identity }, { timeoutMs: CALL_TIMEOUT_MS, idempotencyKey: identity });
    // Confirm the actual listening service, not just a successful process-create receipt.
    const probe = await sandbox.processes.run({ args: [...argv, '--probe'], user: 'root' }, { timeoutMs: CALL_TIMEOUT_MS });
    if (probe.exitCode !== 0 || probe.incomplete) throw new Error('Docker Cloud authenticated ingress is not ready.');
  }

  private async publishedProxy(sandbox: Sandbox) {
    const ports = await sandbox.ports.list({ timeoutMs: CALL_TIMEOUT_MS });
    // Public raw ports would bypass the auth proxy. Refuse adoption until they are withdrawn.
    if (ports.published?.some((p) => p.number !== DOCKER_CLOUD_INGRESS_PORT)) {
      throw new Error('Docker Cloud sandbox has a raw published port; withdraw it before Kortix ingress is enabled.');
    }
    const existing = ports.published?.find((p) => p.number === DOCKER_CLOUD_INGRESS_PORT);
    return existing ?? (await sandbox.ports.create({ number: DOCKER_CLOUD_INGRESS_PORT, protocol: 'tcp' }, { timeoutMs: CALL_TIMEOUT_MS, idempotencyKey: `dc-port-${sandbox.uid}-18080` })).resource;
  }
  private validPortUrl(port: { url?: string }): string {
    if (!port.url) throw new Error('Docker Cloud did not return its published ingress URL.');
    const url = new URL(port.url);
    if (url.protocol !== 'https:') throw new Error('Docker Cloud ingress must use HTTPS.');
    return url.toString().replace(/\/$/, '');
  }

  async start(externalId: string, options?: SandboxStartOptions): Promise<void> {
    let sandbox = await this.get(externalId);
    if (sandbox.status !== 'running') {
      const progress = setInterval(() => { void options?.onProgress?.().catch(() => undefined); }, 30_000);
      try { sandbox = await (await sandbox.start({ timeoutMs: CALL_TIMEOUT_MS })).waitUntilRunning({ timeoutMs: START_TIMEOUT_MS }); }
      finally { clearInterval(progress); }
    }
    await this.ensureProxy(sandbox);
  }
  async ensureRunning(externalId: string): Promise<void> { await this.start(externalId); }
  async ensureAppRuntimeStarted(externalId: string): Promise<void> {
    const sandbox = await this.get(externalId);
    const result = await sandbox.processes.run({ args: ['/bin/sh', '-c', 'test -x /kortix/bin/kortix-appd'], user: 'root' }, { timeoutMs: CALL_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error('Docker Cloud App image is missing the Kortix App supervisor.');
    // The original OCI image entrypoint starts appd. Do not launch duplicate supervisors.
  }
  async renewLifecycle(externalId: string): Promise<void> {
    const sandbox = await this.get(externalId);
    if (!dockerCloudRenewalDue(sandbox.status, sandbox.effectiveFeatures?.timeouts?.expiresAt, this.now(), config.DOCKER_CLOUD_RENEW_BEFORE_MINUTES * 60_000)) return;
    const changed = await sandbox.renewTimeout({ timeoutMs: this.lifetimeMs() }, { timeoutMs: CALL_TIMEOUT_MS });
    const deadline = changed.effectiveFeatures?.timeouts?.expiresAt;
    if (!deadline || deadline.getTime() <= this.now()) throw new Error('Docker Cloud renewal was not confirmed.');
  }
  async stop(externalId: string): Promise<void> {
    const sandbox = await this.get(externalId);
    if (sandbox.status === 'stopped') return;
    await (await sandbox.stop({ timeoutMs: CALL_TIMEOUT_MS })).waitUntilStopped({ timeoutMs: START_TIMEOUT_MS });
  }
  async remove(externalId: string): Promise<void> {
    try {
      const sandbox = await this.get(externalId);
      const changed = await sandbox.delete({ force: true }, { timeoutMs: CALL_TIMEOUT_MS });
      await changed?.waitUntilDeleted({ timeoutMs: START_TIMEOUT_MS });
      // Independent workspace volumes are deliberately retained.
    } catch (error) { if (!dockerCloudNotFound(error)) throw error; }
  }
  async getStatus(externalId: string): Promise<SandboxStatus> {
    try { return dockerCloudStatus((await this.get(externalId)).status); }
    catch (error) { return dockerCloudNotFound(error) ? 'removed' : 'unknown'; }
  }
  async exec(externalId: string, command: string[], options: SandboxExecOptions): Promise<SandboxExecResult> {
    const sandbox = await this.get(externalId);
    const result = await sandbox.processes.run({ args: command, user: 'root' }, { timeoutMs: options.timeoutMs, maxOutputBytes: 16 * 1024 * 1024 });
    if (result.incomplete) throw new Error('Docker Cloud command output is incomplete.');
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
  routeIngress(request: SandboxIngressRequest) {
    const pty = request.transport === 'websocket' && isPtyWebSocketPath(request.path);
    return {
      effectivePort: pty ? 8000 : request.port,
      websocket: request.transport === 'websocket' && (pty || request.port === 8000)
        ? { userContextQueryParam: '__kortix_user_context', ...(pty ? { queryDefaults: { cursor: '0' } } : {}) }
        : undefined,
    };
  }
  async resolveIngress(externalId: string, request: SandboxIngressRequest): Promise<ResolvedSandboxIngress> {
    const sandbox = await this.get(externalId);
    if (sandbox.status !== 'running') throw new Error('Docker Cloud sandbox is not running.');
    const route = this.routeIngress(request);
    if (!Number.isInteger(route.effectivePort) || route.effectivePort < 1 || route.effectivePort > 65535 || route.effectivePort === DOCKER_CLOUD_INGRESS_PORT) {
      throw new Error('Invalid Docker Cloud target port.');
    }
    await this.ensureProxy(sandbox);
    const labels = sandbox.core.labels!;
    return {
      ...route, url: this.validPortUrl(await this.publishedProxy(sandbox)),
      headers: {
        [DOCKER_CLOUD_INGRESS_TOKEN_HEADER]: this.proxyKey(labels[OWNER_LABEL], labels[LOGICAL_LABEL]),
        [DOCKER_CLOUD_TARGET_PORT_HEADER]: String(route.effectivePort),
      },
    };
  }
  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const ingress = await this.resolveIngress(externalId, { port: 8000, transport: 'http' });
    const serviceKey = await (this.dependencies.serviceKey ?? serviceKeyForExternalId)(externalId);
    return { url: ingress.url, headers: { ...ingress.headers, 'Content-Type': 'application/json', ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}) } };
  }
  async getProvisioningStatus(_sandboxId: string): Promise<ProvisioningStatus | null> { return null; }
  async listManagedRunningSandboxes() {
    const owner = await this.owner();
    const result: Array<{ externalId: string; createdAt: Date | null }> = [];
    for await (const sandbox of this.client.all({}, { timeoutMs: CALL_TIMEOUT_MS })) {
      if (sandbox.status !== 'running' || sandbox.core.labels?.[OWNER_LABEL] !== owner) continue;
      result.push({ externalId: dockerCloudExternalId(sandbox.name), createdAt: sandbox.core.createdAt ?? null });
    }
    return result;
  }
}
