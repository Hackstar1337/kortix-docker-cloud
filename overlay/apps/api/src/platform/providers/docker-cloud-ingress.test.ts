import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import NodeWebSocket from 'ws';
import { DOCKER_CLOUD_PROXY_SOURCE } from './docker-cloud-proxy';

const token = 'synthetic-private-ingress-token';
const headers = { 'x-kortix-docker-cloud-token': token, 'x-kortix-docker-cloud-port': '19081', Authorization: 'Bearer synthetic-runtime-token' };
let dir: string;
let processHandle: ReturnType<typeof Bun.spawn>;
let upstream: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kortix-dc-ingress-test-'));
  await mkdir('/tmp/kortix-docker-cloud', { recursive: true, mode: 0o700 });
  await Bun.write('/tmp/kortix-docker-cloud/ingress-key', token);
  upstream = Bun.serve({
    port: 19081, hostname: '127.0.0.1',
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === '/ws') { if (server.upgrade(request, { data: undefined })) return; return new Response('upgrade failed', { status: 400 }); }
      if (path === '/stream') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: proof\ndata: stream-proof\n\n')); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path === '/post') return new Response(await request.text());
      return Response.json({ path, auth: request.headers.get('authorization'), tokenLeaked: request.headers.has('x-kortix-docker-cloud-token'), portLeaked: request.headers.has('x-kortix-docker-cloud-port') });
    },
    websocket: { message(socket, message) { socket.send(message); } },
  });
  const script = join(dir, 'proxy.ts');
  await Bun.write(script, DOCKER_CLOUD_PROXY_SOURCE);
  processHandle = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' });
  const probe = Bun.spawn([process.execPath, script, '--probe'], { stdout: 'ignore', stderr: 'ignore' });
  expect(await probe.exited).toBe(0);
});

afterAll(async () => {
  processHandle?.kill(); if (processHandle) await processHandle.exited;
  upstream?.stop(true); if (dir) await rm(dir, { recursive: true, force: true });
  await rm('/tmp/kortix-docker-cloud', { recursive: true, force: true });
});

describe('Docker Cloud private ingress', () => {
  test('public URL and query parameters grant no access', async () => {
    const response = await fetch('http://127.0.0.1:18080/?x-kortix-docker-cloud-token=' + token);
    expect(response.status).toBe(401);
  });
  test('tampered header is refused before contacting the application', async () => {
    const response = await fetch('http://127.0.0.1:18080/', { headers: { ...headers, 'x-kortix-docker-cloud-token': token + 'tampered' } });
    expect(response.status).toBe(401);
  });
  test('authenticated HTTP preserves runtime auth but never forwards edge credentials', async () => {
    const response = await fetch('http://127.0.0.1:18080/proof', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: '/proof', auth: 'Bearer synthetic-runtime-token', tokenLeaked: false, portLeaked: false });
  });
  test('request body and SSE stream survive the reverse proxy', async () => {
    const body = 'body-proof'.repeat(10000);
    const posted = await fetch('http://127.0.0.1:18080/post', { method: 'POST', headers, body });
    expect(await posted.text()).toBe(body);
    const stream = await fetch('http://127.0.0.1:18080/stream', { headers });
    expect(stream.headers.get('content-type')).toBe('text/event-stream'); expect(await stream.text()).toContain('stream-proof');
  });
  test('port recursion and out-of-range targets are rejected', async () => {
    for (const port of ['18080', '0', '65536', 'invalid']) {
      const response = await fetch('http://127.0.0.1:18080/', { headers: { ...headers, 'x-kortix-docker-cloud-port': port } }); expect(response.status).toBe(400);
    }
  });
  test('WebSocket terminal/desktop transport relays text and binary frames', async () => {
    const received = await new Promise<Array<string | Uint8Array>>((resolve, reject) => {
      const socket = new NodeWebSocket('ws://127.0.0.1:18080/ws', { headers }); socket.binaryType = 'arraybuffer';
      const result: Array<string | Uint8Array> = [];
      const timeout = setTimeout(() => { socket.close(); reject(new Error('WebSocket relay timed out')); }, 5000);
      socket.addEventListener('open', () => { socket.send('terminal-proof'); socket.send(new Uint8Array([1, 2, 3, 255])); });
      socket.addEventListener('message', (event) => {
        result.push(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer));
        if (result.length === 2) { clearTimeout(timeout); socket.close(); resolve(result); }
      });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket relay failed')); });
    });
    expect(received[0]).toBe('terminal-proof'); expect(received[1]).toEqual(new Uint8Array([1, 2, 3, 255]));
  });
  test('backend key rotation updates ingress without restarting the guest', async () => {
    await Bun.write('/tmp/kortix-docker-cloud/ingress-key', 'rotated-synthetic-key');
    const old = await fetch('http://127.0.0.1:18080/', { headers }); expect(old.status).toBe(401);
    const fresh = await fetch('http://127.0.0.1:18080/', { headers: { ...headers, 'x-kortix-docker-cloud-token': 'rotated-synthetic-key' } }); expect(fresh.status).toBe(200);
  });
});
