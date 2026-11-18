import { createHash, randomUUID } from 'node:crypto';
import type { Sandbox } from '@docker/sandboxes';

const PART_BYTES = 1024 * 1024;
const MAX_BYTES = 512 * 1024 * 1024;

/** Small independent file writes avoid the Cloud API's single-request body limit. */
export async function uploadDockerCloudFile(
  sandbox: Sandbox,
  target: string,
  source: Uint8Array | AsyncIterable<Uint8Array>,
  options: { signal?: AbortSignal; timeoutMs?: number; executable?: boolean } = {},
): Promise<{ bytes: number; sha256: string }> {
  if (!target.startsWith('/') || target.includes('\0')) throw new Error('Docker Cloud transfer requires an absolute guest path.');
  const partDir = `/tmp/kortix-transfer-${randomUUID()}`;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 300_000), ...(options.signal ? [options.signal] : [])]);
  const command = async (args: string[]) => {
    const result = await sandbox.processes.run({ args, user: 'root' }, { timeoutMs: 60_000, signal });
    if (result.exitCode !== 0 || result.incomplete) throw new Error('Docker Cloud artifact-transfer command failed.');
    return result.stdout;
  };
  const hash = createHash('sha256');
  let bytes = 0;
  let index = 0;
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  async function* parts() {
    const iterator = source instanceof Uint8Array ? [source] : source;
    for await (const chunk of iterator) {
      for (let offset = 0; offset < chunk.byteLength; offset += PART_BYTES) yield chunk.subarray(offset, offset + PART_BYTES);
    }
  }
  try {
    await command(['mkdir', '-p', partDir]);
    await command(['chmod', '700', partDir]);
    for await (const part of parts()) {
      signal.throwIfAborted();
      if (failure) throw failure;
      bytes += part.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Docker Cloud artifact exceeds the 512 MiB transfer ceiling.');
      hash.update(part);
      const path = `${partDir}/part-${String(index++).padStart(8, '0')}`;
      let write: Promise<void>;
      write = sandbox.files.write(path, part, { mode: 0o600 }, { timeoutMs: 30_000, signal }).then(() => undefined, (error) => { failure ??= error; }).finally(() => { pending.delete(write); });
      pending.add(write);
      if (pending.size >= 3) await Promise.race(pending);
    }
    await Promise.all(pending);
    if (failure) throw failure;
    if (!index) await sandbox.files.write(`${partDir}/part-00000000`, new Uint8Array(), { mode: 0o600 }, { timeoutMs: 30_000, signal });
    const expected = hash.digest('hex');
    const mode = options.executable ? '700' : '600';
    const output = await command(['/bin/sh', '-c', 'set -e; cat "$1"/part-* > "$2"; chmod "$3" "$2"; sha256sum "$2"', 'transfer', partDir, target, mode]);
    const actual = output.trim().split(/\s+/)[0];
    if (actual !== expected) throw new Error('Docker Cloud artifact checksum mismatch; refusing to use incomplete bytes.');
    return { bytes, sha256: expected };
  } finally {
    await Promise.allSettled(pending);
    // Cleanup gets its own bounded budget, even when the transfer signal was cancelled.
    try { await sandbox.processes.run({ args: ['rm', '-rf', partDir], user: 'root' }, { timeoutMs: 30_000 }); } catch { /* Sandbox cleanup or provider timeout removes the temp directory. */ }
  }
}
