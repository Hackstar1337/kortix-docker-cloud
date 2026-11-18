/** Only this authenticated ingress port is published to Docker's edge. */
export const DOCKER_CLOUD_INGRESS_PORT = 18080;
export const DOCKER_CLOUD_INGRESS_TOKEN_HEADER = 'x-kortix-docker-cloud-token';
export const DOCKER_CLOUD_TARGET_PORT_HEADER = 'x-kortix-docker-cloud-port';

/** Standalone Bun program: no npm packages or management credentials in the guest. */
export const DOCKER_CLOUD_PROXY_SOURCE = String.raw`
import { timingSafeEqual } from 'node:crypto';
if (process.argv.includes('--probe')) {
  for (let attempt=0;attempt<10;attempt++) {
    try { const response=await fetch('http://127.0.0.1:18080',{signal:AbortSignal.timeout(1000)});if(response.status===401)process.exit(0); } catch {}
    await Bun.sleep(100);
  }
  process.exit(1);
}
const tokenHeader = 'x-kortix-docker-cloud-token';
const portHeader = 'x-kortix-docker-cloud-port';
const hop = ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'];
async function authenticated(value) {
  const key = (await Bun.file('/tmp/kortix-docker-cloud/ingress-key').text().catch(()=> '')).trim();
  if (!key) return false;
  const a = Buffer.from(value ?? ''); const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a,b);
}
function outgoingHeaders(request) {
  const headers = new Headers(request.headers);
  for (const name of [...hop,tokenHeader,portHeader,'host']) headers.delete(name);
  return headers;
}
Bun.serve({
  hostname:'0.0.0.0', port:18080, maxRequestBodySize:64*1024*1024, idleTimeout:120,
  async fetch(request, server) {
    if (!await authenticated(request.headers.get(tokenHeader))) return new Response('Unauthorized',{status:401});
    const value=request.headers.get(portHeader) ?? '';
    if(!/^\d{1,5}$/.test(value)) return new Response('Invalid target port',{status:400});
    const port=Number(value);
    if(port<1 || port>65535 || port===18080) return new Response('Invalid target port',{status:400});
    const target=new URL(request.url); target.hostname='127.0.0.1';target.port=String(port);target.protocol='http:';
    const headers=outgoingHeaders(request);
    if(request.headers.get('upgrade')?.toLowerCase()==='websocket') {
      target.protocol='ws:';
      for(const name of ['sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol']) headers.delete(name);
      const protocols=request.headers.get('sec-websocket-protocol')?.split(',').map(x=>x.trim()).filter(Boolean);
      if(server.upgrade(request,{data:{target:target.toString(),headers:Object.fromEntries(headers),protocols,queue:[],queuedBytes:0,upstream:null}}))return;
      return new Response('WebSocket upgrade failed',{status:400});
    }
    try {
      const response=await fetch(target,{method:request.method,headers,body:request.method==='GET'||request.method==='HEAD'?undefined:request.body,redirect:'manual',signal:request.signal});
      const output=new Headers(response.headers);for(const name of hop)output.delete(name);
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers:output});
    } catch { return new Response('Sandbox application unavailable',{status:502}); }
  },
  websocket:{
    maxPayloadLength:16*1024*1024, idleTimeout:120,
    open(socket) {
      const data=socket.data;
      const upstream=new WebSocket(data.target,{headers:data.headers,protocols:data.protocols});data.upstream=upstream;
      upstream.binaryType='arraybuffer';
      upstream.addEventListener('open',()=>{for(const message of data.queue)upstream.send(message);data.queue=[];data.queuedBytes=0;});
      upstream.addEventListener('message',event=>{if(typeof event.data==='string')socket.send(event.data);else socket.send(new Uint8Array(event.data));});
      upstream.addEventListener('close',()=>socket.close(1000));
      upstream.addEventListener('error',()=>socket.close(1011));
    },
    message(socket,message) {
      const data=socket.data;
      if(data.upstream?.readyState===WebSocket.OPEN)data.upstream.send(message);
      else {data.queuedBytes+=typeof message==='string'?Buffer.byteLength(message):message.byteLength;if(data.queuedBytes>1024*1024){socket.close(1009);return;}data.queue.push(message);}
    },
    close(socket){try{socket.data.upstream?.close();}catch{}},
  },
});
`;
