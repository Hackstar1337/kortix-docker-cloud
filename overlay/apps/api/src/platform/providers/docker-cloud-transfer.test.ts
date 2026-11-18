import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Sandbox } from '@docker/sandboxes';
import { uploadDockerCloudFile } from './docker-cloud-transfer';

function fixture(options: { failWrite?: boolean; corruptDigest?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: string[][] = [];
  let maximumWrite = 0;
  let assembled: Buffer | undefined;
  const sandbox = {
    files: { write: async (path: string, content: Uint8Array) => {
      maximumWrite = Math.max(maximumWrite, content.byteLength);
      if (options.failWrite && path.endsWith('00000001')) throw new Error('synthetic transfer interruption');
      files.set(path, new Uint8Array(content)); return {};
    } },
    processes: { run: async ({ args }: { args: string[] }) => {
      calls.push(args);
      if (args[0] === '/bin/sh') {
        const prefix = args[4] + '/part-';
        assembled = Buffer.concat([...files].filter(([path]) => path.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([, content]) => Buffer.from(content)));
        const digest = options.corruptDigest ? '0'.repeat(64) : createHash('sha256').update(assembled).digest('hex');
        return { exitCode: 0, stdout: `${digest}  ${args[5]}\n`, stderr: '', incomplete: false };
      }
      return { exitCode: 0, stdout: '', stderr: '', incomplete: false };
    } },
  } as unknown as Sandbox;
  return { sandbox, files, calls, maximumWrite: () => maximumWrite, assembled: () => assembled };
}

describe('Docker Cloud artifact transfer', () => {
  test('large artifacts preserve bytes and never exceed the per-request chunk ceiling', async () => {
    const data = new Uint8Array(2 * 1024 * 1024 + 123); for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const f = fixture(); const result = await uploadDockerCloudFile(f.sandbox, '/tmp/artifact', data);
    expect(result.bytes).toBe(data.length); expect(f.maximumWrite()).toBeLessThanOrEqual(1024 * 1024);
    expect(f.assembled()).toEqual(Buffer.from(data)); expect(result.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(f.calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-rf']);
  });
  test('a rejected write stops assembly and still cleans temporary parts', async () => {
    const f = fixture({ failWrite: true }); await expect(uploadDockerCloudFile(f.sandbox, '/tmp/artifact', new Uint8Array(4 * 1024 * 1024))).rejects.toThrow('synthetic transfer interruption');
    expect(f.assembled()).toBeUndefined(); expect(f.calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-rf']);
  });
  test('checksum mismatch is rejected rather than running a corrupted executable', async () => {
    const f = fixture({ corruptDigest: true }); await expect(uploadDockerCloudFile(f.sandbox, '/tmp/artifact', new Uint8Array([1, 2, 3]))).rejects.toThrow('checksum mismatch');
  });
  test('a relative destination is rejected before creating guest files', async () => {
    const f = fixture(); await expect(uploadDockerCloudFile(f.sandbox, '../artifact', new Uint8Array([1]))).rejects.toThrow('absolute guest path'); expect(f.calls).toEqual([]);
  });
});
