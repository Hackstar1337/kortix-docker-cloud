import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('../sandbox-ownership', () => ({ sandboxOwnershipMarker: async () => 'synthetic-owner' }));
mock.module('./docker-cloud-client', () => ({ getDockerCloudClient: () => { throw new Error('Synthetic client must be passed explicitly'); } }));
mock.module('../../snapshots/build-context', () => ({ DEFAULT_CPU: 2, DEFAULT_MEMORY_GB: 4, KORTIX_ENTRYPOINT: '/synthetic-entrypoint', stageRuntimeBuildContext: async () => { throw new Error('unused fixture'); } }));
mock.module('./docker-cloud-process', () => ({ runDockerCloudCommand: async (_builder: unknown, args: string[]) => ({ exitCode: args.includes('push') ? 1 : 0, stdout: '', stderr: '' }) }));
mock.module('./docker-cloud-transfer', () => ({ uploadDockerCloudFile: async () => ({ bytes: 1, sha256: 'synthetic' }) }));
const { findDockerCloudImages, importDockerCloudStagedContext } = await import('../../snapshots/providers/docker-cloud-builder');
const prefix = `kortix-${createHash('sha256').update('synthetic-owner').digest('hex').slice(0,16)}-`;

test('direct foreign image resource is refused despite a valid images/ identifier', async () => {
  const client: any = { images: { get: async () => ({ name: 'images/synthetic', displayName: 'another-deployment-image' }) } };
  await expect(findDockerCloudImages('images/synthetic', client)).rejects.toThrow('not owned');
});

test('direct owned image resource is resolved exactly', async () => {
  const image = { name: 'images/synthetic', displayName: prefix+'synthetic-snapshot' };
  const client: any = { images: { get: async () => image } };
  expect(await findDockerCloudImages(image.name,client)).toEqual([image]);
});

test('failed private registry push independently scrubs credentials before builder deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(),'kortix-image-cleanup-fixture-'));
  const operations: string[] = [];
  try {
    await writeFile(join(dir,'Dockerfile'),'FROM scratch\n');
    const builder: any = { name: 'sandboxes/synthetic-builder', files: { write: async () => ({}) }, processes: { run: async (input: any) => { operations.push(input.args.join(' ')); return {exitCode:0}; } }, delete: async () => { operations.push('delete');return {waitUntilDeleted:async()=>undefined}; } };
    const image: any = {name:'images/synthetic-image',status:'waitingForPush',pushTarget:{imageRef:'registry.example.invalid/synthetic-namespace/image:synthetic',accessToken:'synthetic-upload-token'},delete:async()=>undefined};
    const client: any = { kits:{launchAndWait:async()=>builder},get:async()=>builder,images:{create:async()=>image,get:async()=>image} };
    await expect(importDockerCloudStagedContext({contextDir:dir,dockerfileName:'Dockerfile'} as any,{snapshotName:'synthetic',spec:{cpu:2,memoryGb:4},runtimeProfile:'standard'} as any,undefined,client)).rejects.toThrow('failed with exit code');
    expect(operations).toContain('rm -rf /tmp/kortix-upload');
    expect(operations.indexOf('rm -rf /tmp/kortix-upload')).toBeLessThan(operations.indexOf('delete'));
  } finally {await rm(dir,{recursive:true,force:true});}
});
