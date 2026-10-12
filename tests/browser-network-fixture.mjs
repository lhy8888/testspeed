import http from 'node:http';
import net from 'node:net';
import { Transform } from 'node:stream';

// Real TCP bytes pass through this fixture; it never invents measurement
// messages, speed results, or upload progress. Queues obey stream backpressure.
export async function createNetworkFixture(targetURL, { rejectWebSocket = false, downloadMbps, uploadMbps, streams = 8, latencyMs = 0 } = {}) {
  const target = new URL(targetURL);
  if (target.protocol !== 'http:') throw new Error('The local TCP fixture requires an HTTP upstream.');
  const sockets = new Set();
  const timers = new Set();
  let closing;
  const stats = { upgrades: 0, rejectedUpgrades: 0, downloadBytes: 0, uploadBytes: 0, firstDownloadAt: null, lastDownloadAt: null, firstUploadAt: null, lastUploadAt: null, maxTransformWritableBytes: 0, flows: [] };
  function later(callback, delay) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
    return timer;
  }
  function cancelTimer(timer) { clearTimeout(timer); timers.delete(timer); }
  const agent = new http.Agent({ keepAlive: true, maxSockets: 40 });
  const server = http.createServer((request, response) => {
    const upstream = http.request({ host: target.hostname, port: target.port || 80, method: request.method, path: request.url, headers: request.headers, agent }, incoming => {
      const startResponse = () => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      };
      if (latencyMs && request.url.startsWith('/api/ping')) {
        const timer = later(startResponse, latencyMs);
        response.once('close', () => cancelTimer(timer));
      }
      else startResponse();
    });
    upstream.on('error', error => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(error.message);
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  const track = socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  server.on('connection', track);
  function meter(direction, mbps, flow) {
    const bytesPerMs = mbps ? mbps * 1000000 / (8 * streams * 1000) : Infinity;
    let nextAt = performance.now() + latencyMs / 2;
    let activeTimer;
    const stream = new Transform({
      highWaterMark: 16384,
      transform(chunk, encoding, done) {
        stats.maxTransformWritableBytes = Math.max(stats.maxTransformWritableBytes, this.writableLength);
        const complete = () => {
          if (this.destroyed) return done();
          const now = performance.now();
          stats[`${direction}Bytes`] += chunk.byteLength;
          flow[`${direction}Bytes`] += chunk.byteLength;
          stats[`first${direction[0].toUpperCase()}${direction.slice(1)}At`] ??= now;
          stats[`last${direction[0].toUpperCase()}${direction.slice(1)}At`] = now;
          done(null, chunk);
        };
        nextAt = Math.max(nextAt, performance.now()) + chunk.byteLength / bytesPerMs;
        const delay = nextAt - performance.now();
        if (delay > 1) activeTimer = later(complete, delay);
        else complete();
      },
    });
    stream.once('close', () => cancelTimer(activeTimer));
    return stream;
  }
  server.on('upgrade', (request, client, head) => {
    stats.upgrades += 1;
    if (rejectWebSocket) {
      stats.rejectedUpgrades += 1;
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host: target.hostname, port: target.port || 80 });
    track(upstream);
    const flow = { path: request.url, direction: new URL(request.url, target).searchParams.get('direction'), downloadBytes: 0, uploadBytes: 0 };
    stats.flows.push(flow);
    const down = meter('download', downloadMbps, flow);
    const up = meter('upload', uploadMbps, flow);
    let upstreamEnded = false;
    const release = () => { upstream.destroy(); client.destroy(); down.destroy(); up.destroy(); };
    upstream.on('error', () => { if (!upstreamEnded) release(); });
    client.on('error', release);
    // A normal upstream EOF must drain already queued bytes, including a
    // finite probe's binary frame and closing handshake, before ending client.
    upstream.on('end', () => {
      upstreamEnded = true;
      client.unpipe(up);
      client.pause();
      up.destroy();
    });
    upstream.on('close', hadError => { if (hadError && !upstreamEnded) release(); else up.destroy(); });
    client.on('close', release);
    upstream.on('connect', () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.byteLength) up.write(head);
      client.pipe(up).pipe(upstream);
      upstream.pipe(down).pipe(client);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    close() {
      closing ??= (async () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        agent.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      })();
      return closing;
    },
  };
}
