import net from 'node:net';

export function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Waits until predicate returns truthy or times out. */
export async function waitFor(pred: () => boolean, timeoutMs = 5_000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timeout');
}

/** Allocates a free TCP port by binding to 0 and closing. */
export async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
