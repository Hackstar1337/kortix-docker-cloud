import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { Sandbox, Sandboxes, Image } from '@docker/sandboxes';
import { getDockerCloudClient } from '../../platform/providers/docker-cloud-client';
import { uploadDockerCloudFile } from '../../platform/providers/docker-cloud-transfer';
import { runDockerCloudCommand } from '../../platform/providers/docker-cloud-process';
import { sandboxOwnershipMarker } from '../../platform/sandbox-ownership';
import {
  stageRuntimeBuildContext, DEFAULT_CPU, DEFAULT_MEMORY_GB, KORTIX_ENTRYPOINT,
  type StagedContext,
} from '../build-context';
import type { BuildableTemplate, BuildLogTap, BuildSnapshotResult } from './index';

const execFileAsync = promisify(execFile);
const CALL_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const IMPORT_TIMEOUT_MS = 10 * 60_000;

export function dockerCloudImageDisplayName(owner: string, snapshotName: string): string {
  const scope = createHash('sha256').update(owner).digest('hex').slice(0, 16);
  return `kortix-${scope}-${snapshotName}`;
}

/** Resolve content identity by owned display name; launch only the returned exact resource. */
export async function findDockerCloudImages(snapshotName: string, client: Sandboxes = getDockerCloudClient()) {
  const owner = await sandboxOwnershipMarker();
  if (snapshotName.startsWith('images/')) {
    const image = await client.images.get(snapshotName, { timeoutMs: CALL_TIMEOUT_MS });
    if (!image.displayName?.startsWith(dockerCloudImageDisplayName(owner, ''))) {
      throw new Error('Docker Cloud image is not owned by this deployment.');
    }
    return [image];
  }
  const name = dockerCloudImageDisplayName(owner, snapshotName);
  const summaries = await client.images.all({}, { timeoutMs: CALL_TIMEOUT_MS }).collect();
  const matches = summaries.filter((image) => image.displayName === name);
  return Promise.all(matches.map((image) => client.images.get(image.name, { timeoutMs: CALL_TIMEOUT_MS })));
}

async function run(builder: Sandbox, argv: string[], timeoutMs: number, signal?: AbortSignal, onProgress?: (step: number | null) => void): Promise<string> {
  const result = await runDockerCloudCommand(builder, argv, { timeoutMs, signal, onProgress });
  if (result.exitCode !== 0) {
    // Do not log registry credentials or raw provider requests. Docker push errors can contain signed URLs.
    throw new Error(`Docker Cloud ${argv[0] === 'docker' ? 'Docker command' : 'build preparation'} failed with exit code ${result.exitCode}.`);
  }
  return result.stdout;
}

/** No Windows-host socket, registry password, or Cloud management token enters the builder. */
export async function importDockerCloudStagedContext(
  ctx: StagedContext, input: BuildableTemplate, tap?: BuildLogTap,
  client: Sandboxes = getDockerCloudClient(),
): Promise<BuildSnapshotResult> {
  const runId = randomUUID();
  const controller = new AbortController();
  let builder: Sandbox | undefined;
  let image: Image | undefined;
  let heartbeatFailure: unknown;
  let heartbeatBusy = false;
  const archive = join(ctx.contextDir, '..', `docker-cloud-${runId}.tgz`);
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void Promise.resolve().then(() => tap?.heartbeat?.()).catch((error) => {
      heartbeatFailure = error; controller.abort();
    }).finally(() => { heartbeatBusy = false; });
  }, 20_000);
  try {
    await tap?.heartbeat?.();
    await execFileAsync('tar', ['-czf', archive, '-C', ctx.contextDir, '.'], { timeout: 120_000 });
    tap?.onLine?.('Uploading the exact staged Kortix Dockerfile and runtime artifacts to an isolated cloud builder.');
    builder = await client.kits.launchAndWait('shell', {
      displayName: `kortix-image-build-${runId}`,
      resources: { cpus: Math.max(2, input.spec.cpu ?? DEFAULT_CPU), memoryMib: Math.max(4096, (input.spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024) },
      lifecycle: { timeoutMs: 50 * 60_000, onTimeout: 'delete', autoResume: false },
      labels: { 'kortix.image_builder_owner': await sandboxOwnershipMarker(), 'kortix.build_id': runId },
    }, { idempotencyKey: `dc-build-${runId}`, timeoutMs: 180_000, signal: controller.signal });
    await run(builder, ['mkdir', '-p', '/tmp/kortix-build/context'], CALL_TIMEOUT_MS, controller.signal);
    await uploadDockerCloudFile(builder, '/tmp/kortix-build/context.tgz', createReadStream(archive, { highWaterMark: 1024 * 1024 }), { timeoutMs: 300_000, signal: controller.signal });
    tap?.onLine?.('Large runtime context transfer verified by SHA256; extracting before Docker build.');
    await run(builder, ['tar', '-xzf', '/tmp/kortix-build/context.tgz', '-C', '/tmp/kortix-build/context'], CALL_TIMEOUT_MS, controller.signal);
    const tag = `kortix-build:${runId}`;
    // The backend-provided argv has no shell interpolation of project names or Dockerfile contents.
    await run(builder, ['docker', 'build', '--progress=plain', '--platform', 'linux/amd64', '--tag', tag, '--file', `/tmp/kortix-build/context/${ctx.dockerfileName}`, '/tmp/kortix-build/context'], BUILD_TIMEOUT_MS, controller.signal, (step) => tap?.onLine?.(`Docker Cloud image build remains active${step === null ? '' : ` (step ${step})`}.`));
    await tap?.heartbeat?.();
    tap?.onLine?.('Dockerfile build completed; registering a private Docker Cloud managed image.');
    image = await client.images.create({
      displayName: dockerCloudImageDisplayName(await sandboxOwnershipMarker(), input.snapshotName),
      fromImage: { captureMode: 'disk', resources: { cpus: input.spec.cpu ?? DEFAULT_CPU, memoryMib: (input.spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024 } },
      // Standard/My Kortix use the shared entrypoint. App images preserve their own OCI entrypoint.
      ...(input.entrypoint ? { startCmd: input.entrypoint } : input.runtimeProfile === 'app' ? {} : { startCmd: [KORTIX_ENTRYPOINT] }),
    }, { idempotencyKey: `dc-image-${runId}`, timeoutMs: CALL_TIMEOUT_MS, signal: controller.signal });
    const target = image.pushTarget;
    if (!target?.imageRef || !target.accessToken || (target.accessTokenExpiresAt && target.accessTokenExpiresAt.getTime() <= Date.now())) {
      throw new Error('Docker Cloud did not return a valid private image upload destination.');
    }
    const registry = target.imageRef.split('/')[0];
    if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(registry)) throw new Error('Invalid Docker Cloud private registry host.');
    const username = target.imageRef.split('/')[1];
    if (!/^[A-Za-z0-9._-]+$/.test(username ?? '')) throw new Error('Invalid Docker Cloud image upload namespace.');
    await run(builder, ['mkdir', '-p', '/tmp/kortix-upload'], CALL_TIMEOUT_MS, controller.signal);
    await run(builder, ['chmod', '700', '/tmp/kortix-upload'], CALL_TIMEOUT_MS, controller.signal);
    // The temporary password authenticates as the IMAGE NAMESPACE, not the operator's Docker ID.
    // Only the isolated builder's private auth file changes; no global docker login is performed.
    const auth = { auth: Buffer.from(`${username}:${target.accessToken}`).toString('base64') };
    const credentials = JSON.stringify({ auths: {
      [registry]: auth,
      ...(registry === 'docker.io' ? { 'https://index.docker.io/v1/': auth } : {}),
    } });
    await builder.files.write('/tmp/kortix-upload/config.json', credentials, {}, { timeoutMs: CALL_TIMEOUT_MS, signal: controller.signal });
    await run(builder, ['docker', 'tag', tag, target.imageRef], CALL_TIMEOUT_MS, controller.signal);
    await run(builder, ['docker', '--config', '/tmp/kortix-upload', 'push', target.imageRef], IMPORT_TIMEOUT_MS, controller.signal);
    await run(builder, ['rm', '-rf', '/tmp/kortix-upload'], CALL_TIMEOUT_MS, controller.signal);
    try {
      const deleted = await (await client.get(builder.name, { timeoutMs: CALL_TIMEOUT_MS })).delete({ force: true }, { timeoutMs: CALL_TIMEOUT_MS });
      await deleted?.waitUntilDeleted({ timeoutMs: 60_000 });
      builder = undefined;
      tap?.onLine?.('Private image upload completed; isolated builder removed before managed-image preparation.');
    } catch { /* Retry cleanup in finally; the bounded provider timeout remains active. */ }
    const deadline = Date.now() + IMPORT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await tap?.heartbeat?.();
      image = await client.images.get(image.name, { timeoutMs: CALL_TIMEOUT_MS, signal: controller.signal });
      if (image.status === 'completed') {
        if (!image.imageDigest) throw new Error('Docker Cloud completed image has no digest.');
        tap?.onLine?.('Docker Cloud managed image is ready; exact external template identity pinned.');
        return { externalTemplateId: image.name };
      }
      if (image.status === 'failed' || image.status === 'deleted') throw new Error('Docker Cloud image preparation failed.');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error('Docker Cloud managed image preparation exceeded its deadline.');
  } catch (error) {
    if (image) {
      try {
        const current = await client.images.get(image.name, { timeoutMs: CALL_TIMEOUT_MS });
        // Never delete a completed image: a concurrent authorized caller may already have pinned it.
        if (current.status !== 'completed') await current.delete({ timeoutMs: CALL_TIMEOUT_MS });
      } catch { console.warn('[docker-cloud] Incomplete image registration cleanup not confirmed.'); }
    }
    if (heartbeatFailure) throw heartbeatFailure;
    throw error;
  } finally {
    clearInterval(heartbeat);
    await rm(archive, { force: true }).catch(() => undefined);
    if (builder) {
      // Scrub temporary upload credentials even if push failed or the main signal was aborted.
      try { await builder.processes.run({ args: ['rm', '-rf', '/tmp/kortix-upload'], user: 'root' }, { timeoutMs: CALL_TIMEOUT_MS }); }
      catch { console.warn('[docker-cloud] Temporary upload credential cleanup not confirmed.'); }
      try {
        const current = await client.get(builder.name, { timeoutMs: CALL_TIMEOUT_MS });
        const deleted = await current.delete({ force: true }, { timeoutMs: CALL_TIMEOUT_MS });
        await deleted?.waitUntilDeleted({ timeoutMs: 60_000 });
      } catch {
        // Not included in the session reaper. Provider delete-on-timeout is a bounded crash backstop.
        console.warn('[docker-cloud] Image-builder cleanup not confirmed; provider timeout remains active.');
      }
    }
  }
}

export async function buildDockerCloudImage(input: BuildableTemplate, tap?: BuildLogTap): Promise<BuildSnapshotResult> {
  if (!input.image && !input.userDockerfile) throw new Error('Docker Cloud image build requires an image or Dockerfile.');
  if (input.region) throw new Error('Docker Cloud cannot honor a region-pinned image build.');
  const ctx = await stageRuntimeBuildContext({
    snapshotName: input.snapshotName, userDockerfile: input.userDockerfile ?? `FROM ${input.image}\n`,
    runtimeProfile: input.runtimeProfile, appContext: input.appContext, containerRuntime: input.containerRuntime,
  });
  try { return await importDockerCloudStagedContext(ctx, input, tap); }
  finally { await rm(ctx.contextDir, { recursive: true, force: true }); }
}
