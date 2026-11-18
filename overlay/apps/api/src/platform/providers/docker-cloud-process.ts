import { randomUUID } from 'node:crypto';
import type { Sandbox } from '@docker/sandboxes';

export async function runDockerCloudCommand(
  sandbox: Sandbox,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; onProgress?: (step: number | null) => void },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const deadline = Date.now() + options.timeoutMs;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const identity = `kortix-image-command-${randomUUID()}`;
  let process = await sandbox.processes.start({ args, user: 'root', label: identity, session: identity }, { timeoutMs: Math.min(30_000, options.timeoutMs), signal, idempotencyKey: identity });
  let cursor: number | string = 0;
  let stdout = '';
  let stderr = '';
  let lastProgress = 0;
  let step: number | null = null;
  try {
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        const page = await process.readOutput({ resumeFrom: cursor, maxBytes: 64 * 1024 }, { timeoutMs: Math.min(15_000, deadline - Date.now()), signal });
        cursor = page.nextResumeFrom ?? cursor;
        for (const chunk of page.chunks ?? []) {
          const text = Buffer.from(chunk.data ?? new Uint8Array()).toString('utf8');
          if (chunk.stream === 'stderr') stderr = (stderr + text).slice(-256 * 1024);
          else stdout = (stdout + text).slice(-256 * 1024);
          for (const match of text.matchAll(/(?:^|\n)#(\d+)\s/g)) step = Number(match[1]);
        }
        if (page.exited?.exitCode != null) return { exitCode: page.exited.exitCode, stdout, stderr };
      } catch (error) {
        if (signal.aborted) throw error;
        // Output-channel availability is not process status. Reconcile via the control plane below.
      }
      process = await process.refresh({ timeoutMs: Math.min(15_000, deadline - Date.now()), signal });
      if (process.state === 'exited' && process.exitCode != null) return { exitCode: process.exitCode, stdout, stderr };
      if (Date.now() - lastProgress >= 30_000) { options.onProgress?.(step); lastProgress = Date.now(); }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(1, deadline - Date.now()))));
    }
    throw new Error('Docker Cloud image command exceeded its authorized execution budget.');
  } catch (error) {
    try { await process.signal('term', { timeoutMs: 15_000 }); } catch { /* The owning builder cleanup/timeout is the final backstop. */ }
    throw error;
  }
}
