import { describe, expect, test, mock } from 'bun:test';
import type { Sandboxes } from '@docker/sandboxes';

mock.module('../../config', () => ({ config: { DOCKER_CLOUD_USERNAME: 'synthetic-user', DOCKER_CLOUD_PAT: 'synthetic-management-token', DOCKER_CLOUD_LIFETIME_MINUTES: 60, DOCKER_CLOUD_RENEW_BEFORE_MINUTES: 20, INTERNAL_SERVICE_KEY: 'synthetic-signing-key' } }));
mock.module('../sandbox-ownership', () => ({ sandboxOwnershipMarker: async () => 'synthetic-owner' }));
mock.module('../service-key', () => ({ serviceKeyForExternalId: async () => 'synthetic-runtime-token' }));
mock.module('../../snapshots/providers/docker-cloud-builder', () => ({ findDockerCloudImages: async () => [{ name: 'images/synthetic-image', status: 'completed', createdAt: new Date(0), resources: { cpus: 2, memoryMib: 4096 } }] }));

const { DockerCloudProvider, dockerCloudStatus, dockerCloudRenewalDue } = await import('./docker-cloud');
const { dockerCloudExternalId, dockerCloudResourceName } = await import('./docker-cloud-client');
const now = Date.parse('2026-01-01T00:00:00Z');
const externalId = dockerCloudExternalId('sandboxes/synthetic-sandbox');

function fixture(status = 'running', expires = now + 10 * 60_000) {
  const calls: Array<{ operation: string; input?: unknown; options?: unknown }> = [];
  const box: any = {
    name: 'sandboxes/synthetic-sandbox', uid: 'synthetic-sandbox', etag: 'synthetic-etag', status,
    core: { labels: { 'kortix.managed': 'synthetic-owner', 'kortix.logical_id': 'synthetic-logical' }, createdAt: new Date(now), resources: { cpus: 2, memoryMib: 4096 } },
    effectiveFeatures: { timeouts: { expiresAt: new Date(expires), onTimeout: 'stop', autoResume: false }, managedVolumes: { attachments: [{ volume: 'volumes/synthetic-volume', target: '/workspace' }] } },
    processes: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', incomplete: false }), all: () => ({ collect: async () => [{ session: 'kortix-docker-cloud-ingress-v1', state: 'running' }] }) },
    files: { write: async () => ({}) },
    ports: { list: async () => ({ published: [{ number: 18080, url: 'https://synthetic.example.invalid' }] }) },
    waitUntilRunning: async () => box,
    waitUntilStopped: async () => box,
    waitUntilDeleted: async () => undefined,
    renewTimeout: async (input: unknown) => { calls.push({ operation: 'renew', input }); box.effectiveFeatures.timeouts.expiresAt = new Date(now + 60 * 60_000); return box; },
    start: async () => { calls.push({ operation: 'start' }); box.status = 'running'; return box; },
    stop: async () => { calls.push({ operation: 'stop' }); box.status = 'stopped'; return box; },
    delete: async () => { calls.push({ operation: 'delete' }); return undefined; },
  };
  const client: any = {
    get: async () => box,
    all: async function* () { yield box; yield { ...box, name: 'sandboxes/not-owned', core: { ...box.core, labels: { 'kortix.managed': 'another-owner' } } }; },
    create: async (input: any, options: unknown) => { calls.push({ operation: 'create', input, options }); box.core.labels = input.labels; return box; },
    volumes: { create: async (input: unknown, options: unknown) => { calls.push({ operation: 'volume', input, options }); return { name: 'volumes/synthetic-volume' }; }, delete: async () => { throw new Error('User volume deletion is forbidden'); } },
  };
  const provider = new DockerCloudProvider({ client: client as Sandboxes, owner: async () => 'synthetic-owner', signingKey: () => 'synthetic-signing-key', serviceKey: async () => 'synthetic-runtime-token', now: () => now });
  return { provider, client, box, calls };
}

describe('Docker Cloud provider contract', () => {
  test('resource names round-trip without slashes in Kortix external identifiers', () => {
    expect(externalId).not.toContain('/'); expect(dockerCloudResourceName(externalId)).toBe('sandboxes/synthetic-sandbox');
    expect(() => dockerCloudResourceName('dc_Li4vLi4vc2VjcmV0')).toThrow();
  });
  test('uncertain and transitional states never become terminal', () => {
    expect(dockerCloudStatus('failed')).toBe('terminal'); expect(dockerCloudStatus('degraded')).toBe('unknown'); expect(dockerCloudStatus('stopping')).toBe('unknown');
  });
  test('renewal applies only to a confirmed running sandbox near expiry', async () => {
    const f = fixture(); await f.provider.renewLifecycle(externalId); expect(f.calls.map((c) => c.operation)).toEqual(['renew']);
    expect(f.calls[0].input).toEqual({ timeoutMs: 3_600_000 });
    expect(dockerCloudRenewalDue('stopped', undefined, now, 1_200_000)).toBe(false);
    expect(dockerCloudRenewalDue('running', new Date(now + 1_800_000), now, 1_200_000)).toBe(false);
    expect(() => dockerCloudRenewalDue('running', undefined, now, 1_200_000)).toThrow();
  });
  test('renewal must not wake a stopped sandbox', async () => {
    const f = fixture('stopped'); await f.provider.renewLifecycle(externalId); expect(f.calls).toEqual([]);
  });
  test('stopping is idempotent and removal never deletes independent storage', async () => {
    const f = fixture('stopped'); await f.provider.stop(externalId); expect(f.calls).toEqual([]); await f.provider.remove(externalId); expect(f.calls.map((c) => c.operation)).toEqual(['delete']);
  });
  test('ownership mismatch fails closed and excludes other deployments from orphan cleanup', async () => {
    const f = fixture(); const managed = await f.provider.listManagedRunningSandboxes(); expect(managed).toHaveLength(1);
    f.box.core.labels['kortix.managed'] = 'another-owner'; expect(await f.provider.getStatus(externalId)).toBe('unknown'); expect(f.provider.stop(externalId)).rejects.toThrow('does not belong');
  });
  test('404 means removed but a 503 is unknown, not data loss', async () => {
    const f = fixture(); f.client.get = async () => { throw { httpStatus: 404 }; }; expect(await f.provider.getStatus(externalId)).toBe('removed');
    f.client.get = async () => { throw { httpStatus: 503 }; }; expect(await f.provider.getStatus(externalId)).toBe('unknown');
  });
  test('create is idempotent, mounts persistent workspace and disables automatic resume', async () => {
    const f = fixture(); const opts = { accountId: 'synthetic-account', userId: 'synthetic-user', name: 'synthetic-name', sandboxId: 'synthetic-logical', snapshot: 'synthetic-snapshot', envVars: { KORTIX_TOKEN: 'synthetic-runtime-token' }, createAttempt: 3 };
    const result = await f.provider.create(opts); await f.provider.create(opts);
    const creates = f.calls.filter((c) => c.operation === 'create');
    expect((creates[0].options as any).idempotencyKey).toBe((creates[1].options as any).idempotencyKey);
    expect((creates[0].input as any).lifecycle).toEqual({ timeoutMs: 3_600_000, onTimeout: 'stop', autoResume: false });
    expect((creates[0].input as any).storage.volumes).toEqual([{ volume: 'volumes/synthetic-volume', target: '/workspace', mode: 'exclusive' }]);
    expect((creates[0].input as any).image).toBe('images/synthetic-image'); expect(JSON.stringify(result.metadata)).not.toContain('synthetic-runtime-token');
  });
  test('rejects unsupported capabilities and management secrets before creating paid resources', async () => {
    const f = fixture(); const opts = { accountId: 'synthetic-account', userId: 'synthetic-user', name: 'synthetic-name', sandboxId: 'synthetic-logical', snapshot: 'synthetic-snapshot', envVars: { KORTIX_TOKEN: 'synthetic-runtime-token' } };
    expect(f.provider.create({ ...opts, workloadType: 'monitor' })).rejects.toThrow('persistent monitor');
    expect(f.provider.create({ ...opts, locationRequired: true })).rejects.toThrow('requested region');
    expect(f.provider.create({ ...opts, envVars: { ...opts.envVars, DOCKER_CLOUD_PAT: 'must-not-leave-backend' } })).rejects.toThrow('management credentials');
    expect(f.calls).toEqual([]);
  });
  test('endpoint preserves runtime authentication behind a separate per-sandbox edge credential', async () => {
    const f = fixture(); const endpoint = await f.provider.resolveEndpoint(externalId);
    expect(endpoint.headers.Authorization).toBe('Bearer synthetic-runtime-token'); expect(endpoint.headers['x-kortix-docker-cloud-port']).toBe('8000');
    expect(endpoint.headers['x-kortix-docker-cloud-token']).toHaveLength(64); expect(endpoint.headers['x-kortix-docker-cloud-token']).not.toBe('synthetic-signing-key');
    expect(f.provider.resolveIngress(externalId, { port: 18080 })).rejects.toThrow('Invalid Docker Cloud target port');
  });
});

test('Docker Cloud cached image launch preserves exact resource identity', async () => {
  const f = fixture();
  const opts = { accountId: 'synthetic-account', userId: 'synthetic-user', name: 'synthetic-name', sandboxId: 'synthetic-logical', envVars: { KORTIX_TOKEN: 'synthetic-runtime-token' } };
  const result = await f.provider.createFromExternalId('images/synthetic-image', opts);
  expect(result.metadata?.image).toBe('images/synthetic-image');
  await expect(f.provider.createFromExternalId('../untrusted-image', opts)).rejects.toThrow('Invalid Docker Cloud image identity');
});

test('Docker Cloud never silently leaves workspace ephemeral when given a different volume target', async () => {
  const f = fixture();
  await expect(f.provider.create({ accountId: 'synthetic-account', userId: 'synthetic-user', name: 'synthetic-name', sandboxId: 'synthetic-logical', envVars: { KORTIX_TOKEN: 'synthetic-runtime-token' }, volumes: { '/home/kortix': { volume: 'volumes/synthetic-volume' } } })).rejects.toThrow('sole persistent volume at /workspace');
  expect(f.calls).toEqual([]);
});

test('Docker Cloud ingress starts use unique identities rather than reusing completed process labels', async () => {
  const f = fixture(); const starts: any[] = [];
  f.box.processes.all = () => ({ collect: async () => [] });
  f.box.processes.run = async (input: any) => ({ exitCode: 0, stdout: input.args?.[2] === 'command -v bun || true' ? '/usr/bin/bun\n' : '', stderr: '', incomplete: false });
  f.box.processes.start = async (input: any, options: any) => { starts.push({ input, options }); return {}; };
  await f.provider.start(externalId); await f.provider.start(externalId);
  expect(starts).toHaveLength(2); expect(starts[0].input.label).not.toBe(starts[1].input.label);
  expect(starts[0].input.session).toBe(starts[0].input.label); expect(starts[0].options.idempotencyKey).toBe(starts[0].input.label);
});

test('Docker Cloud managed-image creation inherits the prepared image resources', async () => {
  const f = fixture();
  await f.provider.create({ accountId: 'synthetic-account', userId: 'synthetic-user', name: 'synthetic-name', sandboxId: 'synthetic-logical', snapshot: 'synthetic-snapshot', envVars: { KORTIX_TOKEN: 'synthetic-runtime-token' } });
  expect((f.calls.find((c) => c.operation === 'create')?.input as any).resources).toBeUndefined();
});

test('Docker Cloud accepts matching image CPU/RAM without an override and rejects mismatches before allocation', async () => {
  const f = fixture(); const opts = { accountId: 'synthetic-account', userId: 'synthetic-user', name: 'synthetic-name', sandboxId: 'synthetic-logical', snapshot: 'synthetic-snapshot', envVars: { KORTIX_TOKEN: 'synthetic-runtime-token' } };
  await f.provider.create({ ...opts, resourceSpec: { cpuCores: 2, memoryGb: 4, diskGb: 20 } });
  expect((f.calls.find((c) => c.operation === 'create')?.input as any).resources).toBeUndefined();
  const mismatch = fixture();
  await expect(mismatch.provider.create({ ...opts, resourceSpec: { cpuCores: 4, memoryGb: 8, diskGb: 20 } })).rejects.toThrow('fixed by the prepared image');
  expect(mismatch.calls).toEqual([]);
});

test('large runtime checkpoints and removal use bounded five-minute waits', async () => {
  const f=fixture();let stopBudget=0,deleteBudget=0;
  f.box.waitUntilStopped=async(options:any)=>{stopBudget=options.timeoutMs;return f.box;};
  f.box.delete=async()=>f.box;
  f.box.waitUntilDeleted=async(options:any)=>{deleteBudget=options.timeoutMs;};
  await f.provider.stop(externalId);await f.provider.remove(externalId);
  expect(stopBudget).toBe(300000);expect(deleteBudget).toBe(300000);
});


test('foreign native workspace references are rejected before sandbox creation', async () => {
  const f = fixture();
  f.client.volumes.get = async () => ({ name: 'volumes/foreign', displayName: 'another-deployment-workspace' });
  await expect(f.provider.create({ accountId: 'synthetic-account', userId: 'synthetic-user', name: 'synthetic', sandboxId: 'synthetic-logical', snapshot: 'synthetic-snapshot', envVars: { KORTIX_TOKEN: 'synthetic-runtime-token' }, volumes: { '/workspace': { volume: 'volumes/foreign' } } })).rejects.toThrow('not bound');
  expect(f.calls).toEqual([]);
});

test('ambiguous create failures carry an owned workspace reconciliation handle without deleting storage', async () => {
  const f = fixture();
  const original = new Error('synthetic network ambiguity');
  f.client.create = async () => { throw original; };
  await expect(f.provider.create({ accountId: 'synthetic-account', userId: 'synthetic-user', name: 'synthetic', sandboxId: 'synthetic-logical', snapshot: 'synthetic-snapshot', envVars: { KORTIX_TOKEN: 'synthetic-runtime-token' } })).rejects.toBe(original);
  expect((original as any).dockerCloudRetainedWorkspace.volumeName).toBe('volumes/synthetic-volume');
  expect((original as any).dockerCloudRetainedWorkspace.workspaceName).toMatch(/^kortix-workspace-[a-f0-9]{64}$/);
});
