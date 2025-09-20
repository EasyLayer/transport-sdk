import { ChildProcess, fork } from 'node:child_process';
import { resolve, join } from 'node:path';
import { Client } from '@easylayer/transport-sdk';

// --- tiny helpers ---
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, timeoutMs = 3000, stepMs = 20) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(stepMs);
  }
  throw new Error('waitFor timeout');
};

async function waitForExit(proc: ChildProcess, timeoutMs = 2000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; resolve(false); }
    }, timeoutMs);
    proc.once('exit', () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(true);
    });
  });
}

// Path to TS child we will run via ts-node/register
const childTs = resolve(__dirname, './ipc-child.ts');

function forkChild(): ChildProcess {
  // IMPORTANT: only ts-node/register; no tsconfig-paths to avoid extra open handles
  return fork(childTs, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    execArgv: ['--require', 'ts-node/register'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // ensure fast transpile; we explicitly point TS config if needed
      TS_NODE_TRANSPILE_ONLY: 'true',
      TS_NODE_FILES: 'true',
      TS_NODE_PROJECT: join(__dirname, '../../tsconfig.json'),
    },
  });
}

describe('IPC e2e', () => {
  let child: ChildProcess | undefined;
  let client: Client | undefined;

  beforeAll(() => {
    try {
      // ensure ts-node is present
      require.resolve('ts-node/register');
    } catch {
      throw new Error('ts-node is not installed. Add it: `yarn add -D ts-node`');
    }
    child = forkChild();

    // Optional: observe child logs for debugging (kept silent by default)
    child?.stdout?.on('data', () => {});
    child?.stderr?.on('data', () => {});
  });

  afterAll(async () => {
    // Close client first (detaches IPC listeners)
    if (client && (client as any).close) {
      await (client as any).close();
      client = undefined;
    }

    if (child) {
      // Ask child to shutdown gracefully; our ipc-child.ts handles { type: 'shutdown' }
      if (child.connected) {
        try { child.send?.({ type: 'shutdown' }); } catch {}
        // break the IPC channel as well (ipc-child also listens 'disconnect')
        try { child.disconnect?.(); } catch {}
      }

      // Wait for child to exit; escalate if needed
      let exited = await waitForExit(child, 1500);
      if (!exited) {
        try { child.kill('SIGTERM'); } catch {}
        exited = await waitForExit(child, 1500);
        if (!exited) {
          try { child.kill('SIGKILL'); } catch {}
          await waitForExit(child, 1500);
        }
      }

      // Defensive: remove any remaining listeners
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child = undefined;
    }
  });

  it(
    'handshake, stream with ACK, and query',
    async () => {
      if (!child) throw new Error('child was not started');

      client = new Client({
        transport: { type: 'ipc-parent', options: { child, connectionTimeout: 2000 } },
      });

      const seen: number[] = [];
      client.subscribe('BlockAddedEvent', (e: any) => {
        // payload in child is { height: number }
        seen.push(e.payload?.height ?? e.payload?.n ?? -1);
      });

      // Child keeps retrying the same batch until ACK; client auto-ACKs on successful onRawBatch.
      await waitFor(() => seen.length >= 2, 5000);
      expect(seen).toEqual([0, 1]);

      // Query round-trip: child's QueryResponse returns { via: 'ipc' }
      const res = await client.querySimple<{}, { via: string }>('GetStatus', {});
      expect(res).toEqual({ via: 'ipc' });
    },
    15_000
  );
});
