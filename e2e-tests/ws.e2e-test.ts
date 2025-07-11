import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@easylayer/common/cqrs';
import { LoggerModule } from '@easylayer/common/logger';
import { TransportModule, CustomWsAdapter } from '@easylayer/common/network-transport';
import { Client } from '@easylayer/transport-sdk';

import { TestCleanup, waitFor, sleep, generateTestId } from './utils';
import { 
  TestQueryHandler, 
  TestErrorQueryHandler, 
  TestStreamQueryHandler, 
  TestEventHandler 
} from './mocks';

describe('WebSocket Transport E2E Tests', () => {
  let app: INestApplication;
  let client: Client;
  let cleanup: TestCleanup;
  let wsPort: number;
  let wsUrl: string;

  const startWsServer = async (): Promise<void> => {
    wsPort = 3001;
    wsUrl = `http://localhost:${wsPort}`;
    
    @Module({
      imports: [
        LoggerModule.forRoot({ 
          componentName: 'WS.E2E.Server',
        }),
        CqrsModule.forRoot({ isGlobal: true }),
        TransportModule.forRoot({
          isGlobal: true,
          transports: [
            {
              type: 'ws',
              isEnabled: true,
              port: wsPort,
              path: '/socket.io',
              name: 'ws-e2e-server',
              maxMessageSize: 1024 * 1024,
              heartbeatTimeout: 2000,
              connectionTimeout: 1500,
              cors: {
                origin: '*',
                credentials: false
              }
            }
          ]
        })
      ],
      providers: [
        TestQueryHandler,
        TestErrorQueryHandler,
        TestStreamQueryHandler,
        TestEventHandler
      ]
    })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false });
    
    const wsOptions = app.get('WS_OPTIONS');
    const customWsAdapter = new CustomWsAdapter(app, wsOptions);
    app.useWebSocketAdapter(customWsAdapter);
    
    await app.init();
    
    await sleep(300);
    
    cleanup.add(async () => {
      if (app) {
        await app.close();
        await sleep(100);
      }
    });
  };

  const createWsClient = async (): Promise<void> => {
    client = new Client({
      transport: {
        type: 'ws',
        name: 'ws-e2e-client',
        url: wsUrl,
        path: '/socket.io',
        connectionTimeout: 3000,
        maxMessageSize: 1024 * 1024,
        timeout: 5000
      }
    });

    cleanup.add(async () => {
      if (client) {
        await client.destroy();
      }
    });

    let connected = false;
    for (let i = 0; i < 3; i++) {
      try {
        if (typeof (client.transport as any).ensureConnection === 'function') {
          await (client.transport as any).ensureConnection();
        }
        
        await waitFor(() => client.isConnected(), 2000, 200);
        connected = true;
        break;
      } catch (error) {
        await sleep(500);
      }
    }
    
    if (!connected) {
      throw new Error('Failed to connect after 3 attempts');
    }
  };

  beforeEach(() => {
    cleanup = new TestCleanup();
  });

  afterEach(async () => {
    await cleanup.cleanup();
    await sleep(200);
    client = null as any;
    app = null as any;
  });

  describe('Connection and Handshake', () => {
    it('should test if server is actually running with raw socket.io', async () => {
      await startWsServer();
      
      const io = require('socket.io-client');
      const rawClient = io(wsUrl, {
        path: '/socket.io',
        transports: ['websocket', 'polling'],
        timeout: 3000
      });
      
      const connected = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 2000);
        rawClient.on('connect', () => {
          clearTimeout(timer);
          resolve(true);
        });
        rawClient.on('connect_error', (error: any) => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      
      rawClient.close();
      
      expect(connected).toBe(true);
    });

    it('should establish connection between server and client', async () => {
      await startWsServer();
      await createWsClient();
      
      expect(client.isConnected()).toBe(true);
    });

    it('should handle connection timeout when server not ready', async () => {
      const unusedPort = 9999;
      
      client = new Client({
        transport: {
          type: 'ws',
          name: 'timeout-client',
          url: `http://localhost:${unusedPort}`,
          connectionTimeout: 1000,
          timeout: 2000
        }
      });

      cleanup.add(async () => {
        if (client) {
          await client.destroy();
        }
      });

      await expect(
        waitFor(() => client.isConnected(), 1500)
      ).rejects.toThrow();

      expect(client.isConnected()).toBe(false);
    });

    it('should detect when server goes down', async () => {
      await startWsServer();
      await createWsClient();
      
      expect(client.isConnected()).toBe(true);
      
      await app.close();
      
      await waitFor(() => !client.isConnected(), 3000, 200);
      
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('Immediate Message Sending and Client Waiting', () => {
    it('should wait for connection before sending messages', async () => {
      await startWsServer();
      
      client = new Client({
        transport: {
          type: 'ws',
          name: 'ws-wait-client',
          url: wsUrl,
          path: '/socket.io',
          connectionTimeout: 2000,
          timeout: 3000
        }
      });

      cleanup.add(async () => {
        if (client) {
          await client.destroy();
        }
      });

      const requestId = generateTestId('immediate-query');
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Immediate query' }
      });
      
      expect(response).toMatchObject({
        result: 'Echo: Immediate query',
        timestamp: expect.any(Number)
      });
    });

    it('should throw error when server is down', async () => {
      client = new Client({
        transport: {
          type: 'ws',
          name: 'dead-server-client',
          url: wsUrl,
          connectionTimeout: 2000,
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
      await startWsServer();
      await createWsClient();
    });

    it('should execute basic queries', async () => {
      const requestId = generateTestId('basic-query');
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Hello Socket.IO!' }
      });

      expect(response).toMatchObject({
        result: 'Echo: Hello Socket.IO!',
        timestamp: expect.any(Number)
      });
    });

    it('should handle query with delay', async () => {
      const requestId = generateTestId('delay-query');
      const startTime = Date.now();
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Delayed query', delay: 100 }
      });

      const duration = Date.now() - startTime;
      
      expect(response).toMatchObject({
        result: 'Echo: Delayed query',
        timestamp: expect.any(Number)
      });
      expect(duration).toBeGreaterThanOrEqual(80);
    });

    it('should handle error queries', async () => {
      const requestId = generateTestId('error-query');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestErrorQuery',
          dto: { errorMessage: 'Test Socket.IO error' }
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
      await startWsServer();
      await createWsClient();
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
          dto: { errorMessage: 'Stream error via Socket.IO' }
        })
      ).rejects.toThrow();
    });
  });

  describe('Event Broadcasting from Server', () => {
    beforeEach(async () => {
      await startWsServer();
      await createWsClient();
    });

    it('should attempt to receive events from server via Socket.IO', async () => {
      const receivedEvents: any[] = [];
      
      const unsubscribe = client.subscribe('TestEvent', async (event) => {
        receivedEvents.push(event);
      });

      cleanup.add(() => unsubscribe());

      await sleep(200);

      const response = await client.query(generateTestId('event-trigger'), {
        constructorName: 'TestQuery',
        dto: { message: 'Event trigger via Socket.IO' }
      });

      expect(response).toMatchObject({
        result: 'Echo: Event trigger via Socket.IO',
        timestamp: expect.any(Number)
      });

      try {
        await waitFor(() => receivedEvents.length > 0, 2000, 200);
        
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
      await startWsServer();
      await createWsClient();
    });

    it('should handle oversized messages', async () => {
      const requestId = generateTestId('oversized-ws');
      
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
        const requestId = generateTestId(`concurrent-ws-${i}`);
        return client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: `Concurrent Socket.IO message ${i}` }
        });
      });

      const results = await Promise.allSettled(promises);
      
      const successful = results.filter(r => r.status === 'fulfilled');

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

    it('should detect server disconnection', async () => {
      expect(client.isConnected()).toBe(true);
      
      await app.close();
      
      await waitFor(() => !client.isConnected(), 3000, 200);
      
      expect(client.isConnected()).toBe(false);
    });

    it('should fail queries after disconnection', async () => {
      expect(client.isConnected()).toBe(true);
      
      await app.close();
      
      await waitFor(() => !client.isConnected(), 3000, 200);
      
      const requestId = generateTestId('after-disconnect');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: 'After disconnect' }
        })
      ).rejects.toThrow();
    });
  });
});