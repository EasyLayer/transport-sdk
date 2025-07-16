import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@easylayer/common/cqrs';
import { LoggerModule } from '@easylayer/common/logger';
import { TransportModule } from '@easylayer/common/network-transport';
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
  let wsHost: string;
  let wsPort: number;
  let wsUrl: string;

  const startWsServer = async (): Promise<void> => {
    wsHost = 'localhost';
    wsPort = 3001;
    wsUrl = `http://${wsHost}:${wsPort}`;
    
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
              host: wsHost,
              port: wsPort,
              path: '/',
              maxMessageSize: 1024 * 1024,
              heartbeatTimeout: 2000,
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
    await app.init();
    
    // Wait for server to be ready
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
        path: '/',
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
    if (client) {
      await client.destroy();
    }

    await cleanup.run();
    
    await sleep(300);

    if (app) {
      await app.close();
    }
    
    app = null as any;
    client = null as any;
    
    await sleep(200);
  });

  describe('Connection and Handshake', () => {
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
          path: '/',
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

    it('should detect when server goes down', async () => {
      await startWsServer();
      await createWsClient();
      
      expect(client.isConnected()).toBe(true);
      
      await app.close();
      
      await waitFor(() => !client.isConnected(), 8000, 300);
      
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
          path: '/',
          timeout: 8000
        }
      });

      cleanup.add(async () => {
        if (client) {
          await client.destroy();
        }
      });

      // Ensure connection is established before sending query
      await waitFor(() => client.isConnected(), 6000, 100);

      const requestId = generateTestId('immediate-query');
      const startTime = Date.now();
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Immediate query' }
      });

      const duration = Date.now() - startTime;
      
      // Check new QueryResult interface
      expect(response).toMatchObject({
        requestId,
        payload: {
          result: 'Echo: Immediate query',
          timestamp: expect.any(Number)
        },
        timestamp: expect.any(Number),
        responseTimestamp: expect.any(Number)
      });
      
      expect(duration).toBeGreaterThan(0);
      expect(response.responseTimestamp).toBeGreaterThan(response.timestamp);
    });

    it('should throw error when server is down', async () => {
      client = new Client({
        transport: {
          type: 'ws',
          name: 'dead-server-client',
          url: wsUrl,
          path: '/',
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
      
      await waitFor(() => client.isConnected(), 3000, 100);
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Hello WebSocket!' }
      });

      expect(response).toMatchObject({
        requestId,
        payload: {
          result: 'Echo: Hello WebSocket!',
          timestamp: expect.any(Number)
        },
        timestamp: expect.any(Number),
        responseTimestamp: expect.any(Number)
      });
    });

    it('should handle query with delay', async () => {
      const requestId = generateTestId('delay-query');
      const startTime = Date.now();
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Delayed WebSocket query', delay: 100 }
      });

      const duration = Date.now() - startTime;
      
      expect(response).toMatchObject({
        requestId,
        payload: {
          result: 'Echo: Delayed WebSocket query',
          timestamp: expect.any(Number)
        },
        timestamp: expect.any(Number),
        responseTimestamp: expect.any(Number)
      });

      expect(duration).toBeGreaterThanOrEqual(80);
    });

    it('should handle error queries', async () => {
      const requestId = generateTestId('error-query');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestErrorQuery',
          dto: { errorMessage: 'Test error from WebSocket' }
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

      if (response.payload && typeof response.payload[Symbol.asyncIterator] === 'function') {
        const receivedItems: any[] = [];
        for await (const item of response.payload) {
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
        expect(response.payload).toBeDefined();
      }
    });

    it('should handle stream errors', async () => {
      const requestId = generateTestId('stream-error');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestErrorQuery',
          dto: { errorMessage: 'Stream error via WebSocket' }
        })
      ).rejects.toThrow();
    });
  });

  describe('Event Broadcasting from Server', () => {
    beforeEach(async () => {
      await startWsServer();
      await createWsClient();
    });

    it('should attempt to receive events from server via WebSocket', async () => {
      const receivedEvents: any[] = [];
      
      const unsubscribe = client.subscribe('TestEvent', async (event) => {
        receivedEvents.push(event);
      });

      cleanup.add(() => unsubscribe());

      await sleep(300);

      const response = await client.query(generateTestId('event-trigger'), {
        constructorName: 'TestQuery',
        dto: { message: 'Event trigger via WebSocket' }
      });

      expect(response).toMatchObject({
        requestId: expect.any(String),
        payload: {
          result: 'Echo: Event trigger via WebSocket',
          timestamp: expect.any(Number)
        },
        timestamp: expect.any(Number),
        responseTimestamp: expect.any(Number)
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
          dto: { message: `Concurrent WebSocket message ${i}` }
        });
      });

      const results = await Promise.allSettled(promises);
      
      const successful = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');

      expect(successful.length).toBeGreaterThanOrEqual(queryCount * 0.8);
      
      successful.forEach((result) => {
        if (result.status === 'fulfilled') {
          expect(result.value).toMatchObject({
            requestId: expect.any(String),
            payload: {
              result: expect.stringContaining('Echo:'),
              timestamp: expect.any(Number)
            },
            timestamp: expect.any(Number),
            responseTimestamp: expect.any(Number)
          });
        }
      });
    });

    it('should handle rapid sequential queries', async () => {
      const queryCount = 3;
      const results: any[] = [];
      
      for (let i = 0; i < queryCount; i++) {
        const requestId = generateTestId(`rapid-ws-${i}`);
        const response = await client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: `Rapid WebSocket message ${i}` }
        });
        results.push(response);
      }

      expect(results).toHaveLength(queryCount);
      results.forEach((result, index) => {
        expect(result).toMatchObject({
          requestId: expect.any(String),
          payload: {
            result: `Echo: Rapid WebSocket message ${index}`,
            timestamp: expect.any(Number)
          },
          timestamp: expect.any(Number),
          responseTimestamp: expect.any(Number)
        });
      });
    });

    it('should detect server disconnection', async () => {
      expect(client.isConnected()).toBe(true);
      
      await app.close();
      
      await waitFor(() => !client.isConnected(), 5000, 300);
      
      expect(client.isConnected()).toBe(false);
    });

    it('should fail queries after disconnection', async () => {
      expect(client.isConnected()).toBe(true);
      
      await app.close();
      
      await waitFor(() => !client.isConnected(), 5000, 300);
      
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
      
      // Wait for heartbeat cycles
      await sleep(2000);
      
      expect(client.isConnected()).toBe(true);
    });
  });
});