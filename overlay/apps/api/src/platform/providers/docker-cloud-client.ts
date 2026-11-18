import { Sandboxes, pat } from '@docker/sandboxes';
import { config } from '../../config';

let client: Sandboxes | undefined;

/** Cloud management credentials never enter a task sandbox or browser. */
export function getDockerCloudClient(): Sandboxes {
  if (client) return client;
  if (!config.DOCKER_CLOUD_USERNAME || !config.DOCKER_CLOUD_PAT) {
    throw new Error('Docker Cloud requires DOCKER_CLOUD_USERNAME and a Cloud-enabled DOCKER_CLOUD_PAT.');
  }
  client = new Sandboxes({
    auth: pat({ username: config.DOCKER_CLOUD_USERNAME, personalAccessToken: config.DOCKER_CLOUD_PAT }),
    maxRetries: 2,
  });
  return client;
}

/** Resource names contain slashes; Kortix ingress identifiers must not. */
export function dockerCloudExternalId(resourceName: string): string {
  if (!/^sandboxes\/[A-Za-z0-9._-]+$/.test(resourceName)) throw new Error('Invalid Docker Cloud sandbox resource name.');
  return `dc_${Buffer.from(resourceName, 'utf8').toString('base64url')}`;
}

export function dockerCloudResourceName(externalId: string): string {
  if (!/^dc_[A-Za-z0-9_-]+$/.test(externalId) || externalId.length > 255) {
    throw new Error('Invalid Docker Cloud sandbox identifier.');
  }
  const name = Buffer.from(externalId.slice(3), 'base64url').toString('utf8');
  if (dockerCloudExternalId(name) !== externalId) throw new Error('Invalid Docker Cloud sandbox identifier.');
  return name;
}

export function dockerCloudNotFound(error: unknown): boolean {
  return (error as { httpStatus?: number } | null)?.httpStatus === 404;
}
