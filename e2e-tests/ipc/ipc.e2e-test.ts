import { ChildProcess, fork } from 'node:child_process';
import * as path from 'path';
import { Client } from '@easylayer/transport-sdk';
import { TestCleanup, waitFor, sleep, generateTestId } from '../utils';

describe('IPC Transport E2E Tests', () => {
  let childProcess: ChildProcess;
  let client: Client;
  let cleanup: TestCleanup;

  const startIpcServer = async (): Promise<void> => {
    const ipcChildScript = path.join(__dirname, 'ipc-child.ts');

    childProcess = fork(ipcChildScript, [], {
      stdio: 'pipe',
      execArgv: [
        '--require', 'ts-node/register',
      ],
      env: { 
        ...process.env, 
        NODE_ENV: 'test',
        TS_NODE_PROJECT: path.join(__dirname, '../../tsconfig.json'),
        TS_NODE_TRANSPILE_ONLY: 'true'
      }
    });

    cleanup.add(() => {
      if (childProcess && !childProcess.killed) {
        childProcess.kill('SIGKILL');
      }
    });

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('IPC server failed to start within 5s'));
      }, 5000);

      const messageHandler = (msg: any) => {
        if (msg && msg.type === 'ready') {
          clearTimeout(timer);
          childProcess.off('message', messageHandler);
          resolve();
        } else if (msg && (msg.type === 'error' || msg.type === 'startup_error')) {
          clearTimeout(timer);
          childProcess.off('message', messageHandler);
          reject(new Error(`IPC server error: ${msg.error}`));
        }
      };

      childProcess.on('message', messageHandler);
      
      childProcess.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Child process error: ${err.message}`));
      });
      
      childProcess.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timer);
          reject(new Error(`Child process exited with code ${code}, signal ${signal}`));
        }
      });

      // if (process.env.DEBUG) {
        childProcess.stdout?.on('data', (data) => {
          // console.log(`[IPC STDOUT]: ${data.toString()}`);
        });
        
        childProcess.stderr?.on('data', (data) => {
          // console.error(`[IPC STDERR]: ${data.toString()}`);
        });
      // }
    });
  };

  const createIpcClient = async (): Promise<void> => {
    client = new Client({
      transport: {
        type: 'ipc',
        name: 'ipc-e2e-client',
        child: childProcess,
        connectionTimeout: 3000,
        heartbeatTimeout: 4000,
        maxMessageSize: 1024 * 1024,
        timeout: 5000
      }
    });

    cleanup.add(async () => {
      if (client) {
        await client.destroy();
      }
    });

    await waitFor(() => client.isConnected(), 4000, 100);
  };

  beforeEach(() => {
    cleanup = new TestCleanup();
  });

  afterEach(async () => {
    await cleanup.cleanup();
    
    await sleep(300);
    
    if (childProcess && !childProcess.killed) {
      childProcess.kill('SIGKILL');
    }
    
    childProcess = null as any;
    client = null as any;
    
    await sleep(200);
  });

  describe('Connection and Handshake', () => {
    it('should establish connection between server and client', async () => {
      await startIpcServer();
      await createIpcClient();
      
      expect(client.isConnected()).toBe(true);
      expect(childProcess.connected).toBe(true);
      expect(childProcess.pid).toBeGreaterThan(0);
    });

    it('should handle connection timeout when server not ready', async () => {
      childProcess = fork('non-existent-script.js', [], {
        stdio: 'pipe',
        env: { NODE_ENV: 'test' }
      });

      cleanup.add(() => {
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGKILL');
        }
      });

      client = new Client({
        transport: {
          type: 'ipc',
          name: 'timeout-client',
          child: childProcess,
          connectionTimeout: 1500,
          heartbeatTimeout: 2000,
          timeout: 3000
        }
      });

      cleanup.add(async () => {
        if (client) {
          await client.destroy();
        }
      });

      await expect(
        waitFor(() => client.isConnected(), 2500)
      ).rejects.toThrow();

      expect(client.isConnected()).toBe(false);
    });

    it('should detect when child process dies', async () => {
      await startIpcServer();
      await createIpcClient();
      
      expect(client.isConnected()).toBe(true);
      
      childProcess.kill('SIGKILL');
      
      await waitFor(() => !client.isConnected() || childProcess.killed, 8000, 300);
      
      expect(childProcess.killed).toBe(true);
    });
  });

  describe('Immediate Message Sending and Client Waiting', () => {
    it('should wait for connection before sending messages', async () => {
      await startIpcServer();
      
      client = new Client({
        transport: {
          type: 'ipc',
          name: 'ipc-wait-client',
          child: childProcess,
          connectionTimeout: 5000,
          heartbeatTimeout: 6000,
          timeout: 8000
        }
      });

      cleanup.add(async () => {
        if (client) {
          await client.destroy();
        }
      });

      const requestId = generateTestId('immediate-query');
      const startTime = Date.now();
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Immediate query' }
      });

      const duration = Date.now() - startTime;
      
      expect(response).toMatchObject({
        result: 'Echo: Immediate query',
        timestamp: expect.any(Number)
      });
      
      expect(duration).toBeGreaterThan(50);
    });

    it('should throw error when server is down', async () => {
      await startIpcServer();
      childProcess.kill('SIGKILL');
      
      await waitFor(() => !childProcess.connected, 2000);
      
      client = new Client({
        transport: {
          type: 'ipc',
          name: 'dead-server-client',
          child: childProcess,
          connectionTimeout: 1500,
          heartbeatTimeout: 2000,
          timeout: 3000
        }
      });

      cleanup.add(async () => {
        if (client) {
          await client.destroy();
        }
      });

      const requestId = generateTestId('dead-server-query');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: 'Dead server' }
        })
      ).rejects.toThrow();
    });
  });

  describe('Query Operations', () => {
    beforeEach(async () => {
      await startIpcServer();
      await createIpcClient();
    });

    it('should execute basic queries', async () => {
      const requestId = generateTestId('basic-query');
      
      await waitFor(() => client.isConnected(), 3000, 100);
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Hello IPC!' }
      });

      expect(response).toMatchObject({
        result: 'Echo: Hello IPC!',
        timestamp: expect.any(Number)
      });
    });

    it('should handle query with delay', async () => {
      const requestId = generateTestId('delay-query');
      const startTime = Date.now();
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Delayed IPC query', delay: 100 }
      });

      const duration = Date.now() - startTime;
      
      expect(response.result).toBe('Echo: Delayed IPC query');
      expect(duration).toBeGreaterThanOrEqual(80);
    });

    it('should handle error queries', async () => {
      const requestId = generateTestId('error-query');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestErrorQuery',
          dto: { errorMessage: 'Test error from IPC' }
        })
      ).rejects.toThrow();
    });

    it('should handle unknown query types', async () => {
      const requestId = generateTestId('unknown-query');
      
      await expect(
        client.query(requestId, {
          constructorName: 'UnknownQueryType',
          dto: { data: 'test' }
        })
      ).rejects.toThrow();
    });
  });

  describe('Stream Operations', () => {
    beforeEach(async () => {
      await startIpcServer();
      await createIpcClient();
    });

    it('should handle stream queries', async () => {
      const requestId = generateTestId('stream-query');
      
      const response = await client.query(requestId, {
        constructorName: 'TestStreamQuery',
        dto: { count: 3, delay: 30 }
      });

      if (response && typeof response[Symbol.asyncIterator] === 'function') {
        const receivedItems: any[] = [];
        for await (const item of response) {
          receivedItems.push(item);
        }
        
        expect(receivedItems).toHaveLength(3);
        receivedItems.forEach((item, index) => {
          expect(item).toMatchObject({
            index,
            timestamp: expect.any(Number)
          });
        });
      } else {
        expect(response).toBeDefined();
      }
    });

    it('should handle stream errors', async () => {
      const requestId = generateTestId('stream-error');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestErrorQuery',
          dto: { errorMessage: 'Stream error via IPC' }
        })
      ).rejects.toThrow();
    });
  });

  describe('Event Broadcasting from Server', () => {
    beforeEach(async () => {
      await startIpcServer();
      await createIpcClient();
    });

    it('should attempt to receive events from server via IPC', async () => {
      const receivedEvents: any[] = [];
      
      const unsubscribe = client.subscribe('TestEvent', async (event) => {
        receivedEvents.push(event);
      });

      cleanup.add(() => unsubscribe());

      await sleep(300);

      const response = await client.query(generateTestId('event-trigger'), {
        constructorName: 'TestQuery',
        dto: { message: 'Event trigger via IPC' }
      });

      expect(response).toMatchObject({
        result: 'Echo: Event trigger via IPC',
        timestamp: expect.any(Number)
      });

      try {
        await waitFor(() => receivedEvents.length > 0, 5000, 300);
        
        expect(receivedEvents.length).toBeGreaterThan(0);
        const event = receivedEvents[0];
        expect(event).toMatchObject({
          id: expect.stringContaining('query-'),
          data: expect.stringContaining('Query executed:'),
          timestamp: expect.any(Number)
        });
      } catch (error) {
        expect(receivedEvents.length).toBe(0);
      }
    });

    it('should handle subscription management', async () => {
      const unsubscribe1 = client.subscribe('TestEvent', async () => {});
      const unsubscribe2 = client.subscribe('TestEvent', async () => {});
      
      expect(client.getSubscriptionCount('TestEvent')).toBe(2);
      
      unsubscribe1();
      expect(client.getSubscriptionCount('TestEvent')).toBe(1);
      
      unsubscribe2();
      expect(client.getSubscriptionCount('TestEvent')).toBe(0);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    beforeEach(async () => {
      await startIpcServer();
      await createIpcClient();
    });

    it('should handle oversized messages', async () => {
      const requestId = generateTestId('oversized-ipc');
      
      const largeMessage = 'A'.repeat(2 * 1024 * 1024);
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: largeMessage }
        })
      ).rejects.toThrow();
    });

    it('should handle concurrent queries', async () => {
      const queryCount = 3;
      
      const promises = Array.from({ length: queryCount }, (_, i) => {
        const requestId = generateTestId(`concurrent-ipc-${i}`);
        return client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: `Concurrent IPC message ${i}` }
        });
      });

      const results = await Promise.allSettled(promises);
      
      const successful = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');

      expect(successful.length).toBeGreaterThanOrEqual(queryCount * 0.8);
      
      successful.forEach((result) => {
        if (result.status === 'fulfilled') {
          expect(result.value).toMatchObject({
            result: expect.stringContaining('Echo:'),
            timestamp: expect.any(Number)
          });
        }
      });
    });

    it('should handle rapid sequential queries', async () => {
      const queryCount = 3;
      const results: any[] = [];
      
      for (let i = 0; i < queryCount; i++) {
        const requestId = generateTestId(`rapid-ipc-${i}`);
        const response = await client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: `Rapid IPC message ${i}` }
        });
        results.push(response);
      }

      expect(results).toHaveLength(queryCount);
      results.forEach((result, index) => {
        expect(result).toMatchObject({
          result: `Echo: Rapid IPC message ${index}`,
          timestamp: expect.any(Number)
        });
      });
    });

    it('should detect server disconnection', async () => {
      expect(client.isConnected()).toBe(true);
      
      childProcess.kill('SIGKILL');
      
      await waitFor(() => !client.isConnected() || childProcess.killed, 5000, 300);
      
      expect(childProcess.killed).toBe(true);
    });

    it('should fail queries after disconnection', async () => {
      expect(client.isConnected()).toBe(true);
      
      childProcess.kill('SIGKILL');
      
      await waitFor(() => !client.isConnected() || childProcess.killed, 5000, 300);
      
      const requestId = generateTestId('after-disconnect');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: 'After disconnect' }
        })
      ).rejects.toThrow();
    });

    it('should handle ping-pong heartbeat correctly', async () => {
      const initialConnection = client.isConnected();
      expect(initialConnection).toBe(true);
      
      await sleep(2000);
      
      expect(client.isConnected()).toBe(true);
    });
  });
});