import { getDockerCloudClient, dockerCloudNotFound } from '../../platform/providers/docker-cloud-client';
import { sandboxOwnershipMarker } from '../../platform/sandbox-ownership';
import { buildDockerCloudImage, dockerCloudImageDisplayName, findDockerCloudImages } from './docker-cloud-builder';
import type { BuildLogTap, BuildableTemplate, BuildSnapshotResult, ProviderState, SandboxProviderAdapter } from './index';

export function dockerCloudImageState(status: string): ProviderState {
  switch (status) {
    case 'completed': return 'active';
    case 'failed': return 'build_failed';
    case 'deleted': return 'missing';
    case 'pending': case 'waitingForPush': case 'preparing': return 'building';
    default: return 'unknown';
  }
}

/** Docker Cloud uses an OCI builder plus private image import, not a different runtime image. */
export class DockerCloudImageAdapter implements SandboxProviderAdapter {
  readonly id = 'docker-cloud' as const;
  isConfigured(): boolean {
    try { getDockerCloudClient(); return true; } catch { return false; }
  }
  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<BuildSnapshotResult> {
    const existing = await this.getSnapshotExternalId(input.snapshotName);
    if (existing && (await this.getSnapshotStateByExternalId(existing)) === 'active') return { externalTemplateId: existing };
    return buildDockerCloudImage(input, tap);
  }
  async getSnapshotExternalId(snapshotName: string): Promise<string | null> {
    const images = await findDockerCloudImages(snapshotName);
    const ready = images.filter((image) => image.status === 'completed').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (ready[0]) return ready[0].name;
    const newest = images.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return newest?.name ?? null;
  }
  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    try {
      const images = await findDockerCloudImages(snapshotName);
      if (!images.length) return 'missing';
      if (images.some((image) => image.status === 'completed')) return 'active';
      const newest = images.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      // A crashed builder cannot refresh the one-time upload token. Permit a fresh build instead of hanging forever.
      if (newest.status === 'waitingForPush' && Date.now() - newest.createdAt.getTime() > 30 * 60_000) return 'build_failed';
      return dockerCloudImageState(newest.status);
    } catch (error) { return dockerCloudNotFound(error) ? 'missing' : 'unknown'; }
  }
  async getSnapshotStateByExternalId(externalId: string): Promise<ProviderState> {
    try {
      const images = await findDockerCloudImages(externalId);
      return images[0] ? dockerCloudImageState(images[0].status) : 'missing';
    }
    catch (error) { return dockerCloudNotFound(error) ? 'missing' : 'unknown'; }
  }
  async findFirstActiveSnapshot(names: readonly string[]): Promise<string | null> {
    for (const name of names) if ((await this.getSnapshotState(name)) === 'active') return name;
    return null;
  }
  async deleteSnapshot(snapshotName: string): Promise<void> {
    try {
      const images = await findDockerCloudImages(snapshotName);
      const prefix = dockerCloudImageDisplayName(await sandboxOwnershipMarker(), '');
      for (const image of images) {
        if (!image.displayName?.startsWith(prefix)) throw new Error('Docker Cloud image is not owned by this deployment.');
        try { await image.delete({ timeoutMs: 30_000 }); } catch (error) { if (!dockerCloudNotFound(error)) throw error; }
      }
    } catch (error) { if (!dockerCloudNotFound(error)) throw error; }
  }
  async listSnapshots(): Promise<Array<{ name: string }>> {
    const prefix = dockerCloudImageDisplayName(await sandboxOwnershipMarker(), '');
    const images = await getDockerCloudClient().images.all({}, { timeoutMs: 30_000 }).collect();
    return images.filter((image) => image.displayName?.startsWith(prefix)).map((image) => ({ name: image.displayName!.slice(prefix.length) }));
  }
}
export const dockerCloudImageProvider = new DockerCloudImageAdapter();
