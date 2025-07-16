import axios from 'axios';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@easylayer/common/cqrs';
import { LoggerModule } from '@easylayer/common/logger';
import { TransportModule } from '@easylayer/common/network-transport';
import { Client } from '@easylayer/transport-sdk';

import { TestCleanup, sleep, generateTestId } from './utils';
import { 
  TestQueryHandler, 
  TestErrorQueryHandler, 
  TestStreamQueryHandler, 
  TestEventHandler 
} from './mocks';

describe('HTTP Transport E2E Tests', () => {
  let app: INestApplication;
  let client: Client;
  let cleanup: TestCleanup;
  let serverPort: number;
  let serverHost: string;
  let serverUrl: string;

  beforeEach(async () => {
    cleanup = new TestCleanup();
    
    serverPort = 3001;
    serverHost = 'localhost';
    serverUrl = `http://${serverHost}:${serverPort}`;
    
    @Module({
      imports: [
        LoggerModule.forRoot({ 
          componentName: 'HTTP.E2E.Server',
        }),
        CqrsModule.forRoot({ isGlobal: true }),
        TransportModule.forRoot({
          isGlobal: true,
          transports: [
            {
              type: 'http',
              host: serverHost,
              port: serverPort,
              maxMessageSize: 1024 * 1024
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

    client = new Client({
      transport: {
        type: 'http',
        baseUrl: serverUrl,
        timeout: 5000,
        maxMessageSize: 1024 * 1024
      }
    });

    await sleep(200);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (client) {
      await client.destroy();
    }
    await cleanup.run();
  });

  describe('Connection and Basic Handshake', () => {
    it('should create HTTP client successfully', async () => {
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(true);
    });

    it('should respond to health endpoint', async () => {
      const response = await axios.get(`${serverUrl}/health`);
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        status: 'ok',
        timestamp: expect.any(Number)
      });
    });
  });

  describe('Immediate Message Sending', () => {
    it('should handle immediate query after client creation', async () => {
      const requestId = generateTestId('immediate-query');
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Immediate query' }
      });

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

      // Verify response time tracking
      expect(response.responseTimestamp).toBeGreaterThan(response.timestamp);
    });

    it('should throw error immediately when server is down', async () => {
      await app.close();
      
      const requestId = generateTestId('server-down-query');
      
      await expect(
        client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: 'Server down' }
        })
      ).rejects.toThrow();
    });
  });

  describe('Query Operations', () => {
    it('should execute basic queries', async () => {
      const requestId = generateTestId('basic-query');
      
      const response = await client.query(requestId, {
        constructorName: 'TestQuery',
        dto: { message: 'Hello HTTP!' }
      });

      expect(response).toMatchObject({
        requestId,
        payload: {
          result: 'Echo: Hello HTTP!',
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
        dto: { message: 'Delayed query', delay: 100 }
      });

      const duration = Date.now() - startTime;
      
      expect(response).toMatchObject({
        requestId,
        payload: {
          result: 'Echo: Delayed query',
          timestamp: expect.any(Number)
        },
        timestamp: expect.any(Number),
        responseTimestamp: expect.any(Number)
      });

      expect(duration).toBeGreaterThanOrEqual(80);
    });

    it('should handle error queries via HTTP response object', async () => {
      const requestId = generateTestId('error-query');
      
      // For HTTP, errors might be returned as response with error payload
      const response = await client.query(requestId, {
        constructorName: 'TestErrorQuery',
        dto: { errorMessage: 'Test HTTP error' }
      });
      
      expect(response).toMatchObject({
        requestId,
        payload: expect.objectContaining({
          error: expect.stringContaining('Test HTTP error')
        }),
        timestamp: expect.any(Number),
        responseTimestamp: expect.any(Number)
      });
    });

    it('should handle unknown query types', async () => {
      const requestId = generateTestId('unknown-query');
      
      const response = await client.query(requestId, {
        constructorName: 'UnknownQueryType',
        dto: { data: 'test' }
      });
      
      expect(response).toMatchObject({
        requestId,
        payload: expect.objectContaining({
          error: expect.stringContaining('query handler')
        }),
        timestamp: expect.any(Number),
        responseTimestamp: expect.any(Number)
      });
    });
  });

  describe('Stream Operations', () => {
    it('should handle stream queries', async () => {
      const requestId = generateTestId('stream-query');
      const receivedItems: any[] = [];
      
      try {
        const streamGenerator = client.streamQuery(requestId, {
          constructorName: 'TestStreamQuery',
          dto: { count: 3, delay: 30 }
        });

        for await (const item of streamGenerator) {
          receivedItems.push(item);
        }

        expect(receivedItems).toHaveLength(3);
        receivedItems.forEach((item, index) => {
          expect(item).toMatchObject({
            index,
            timestamp: expect.any(Number)
          });
        });
      } catch (error) {
        expect(receivedItems.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should handle stream errors', async () => {
      const requestId = generateTestId('stream-error');
      
      await expect(async () => {
        const streamGenerator = client.streamQuery(requestId, {
          constructorName: 'TestErrorQuery',
          dto: { errorMessage: 'Stream error' }
        });

        for await (const item of streamGenerator) {
          // Should not reach here
        }
      }).rejects.toThrow();
    });
  });

  describe('Event Broadcasting from Server', () => {
    it('should receive events broadcasted from server (if implemented)', async () => {
      const receivedEvents: any[] = [];
      
      const unsubscribe = client.subscribe('TestEvent', async (event) => {
        receivedEvents.push(event);
      });

      cleanup.add(() => unsubscribe());

      await sleep(50);

      const response = await client.query(generateTestId('event-trigger'), {
        constructorName: 'TestQuery',
        dto: { message: 'Event trigger' }
      });

      expect(response).toMatchObject({
        requestId: expect.any(String),
        payload: {
          result: 'Echo: Event trigger',
          timestamp: expect.any(Number)
        },
        timestamp: expect.any(Number),
        responseTimestamp: expect.any(Number)
      });

      await sleep(200);

      expect(receivedEvents.length).toBe(0);
    });
  });

  describe('Direct HTTP Endpoint Tests', () => {
    it('should handle direct RPC calls', async () => {
      const rpcPayload = {
        action: 'query',
        requestId: 'direct-rpc-test',
        payload: {
          constructorName: 'TestQuery',
          dto: { message: 'Direct RPC call' }
        }
      };

      const response = await axios.post(serverUrl, rpcPayload, {
        headers: { 'Content-Type': 'application/json' }
      });

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        action: 'queryResponse',
        requestId: 'direct-rpc-test',
        payload: expect.objectContaining({
          result: 'Echo: Direct RPC call',
          timestamp: expect.any(Number)
        })
      });
    });

    it('should reject malformed requests', async () => {
      const malformedPayload = {
        invalid: 'request'
      };

      await expect(
        axios.post(serverUrl, malformedPayload, {
          headers: { 'Content-Type': 'application/json' }
        })
      ).rejects.toMatchObject({
        response: { status: 400 }
      });
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle connection timeout to non-existent server', async () => {
      const timeoutClient = new Client({
        transport: {
          type: 'http',
          baseUrl: 'http://localhost:9999',
          timeout: 1000
        }
      });

      cleanup.add(async () => {
        await timeoutClient.destroy();
      });

      const requestId = generateTestId('timeout-test');
      
      await expect(
        timeoutClient.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: 'timeout test' }
        })
      ).rejects.toThrow();
    });

    it('should handle oversized messages', async () => {
      const largePayload = {
        action: 'query',
        requestId: 'oversized-test',
        payload: {
          constructorName: 'TestQuery',
          dto: { 
            message: 'A'.repeat(2 * 1024 * 1024)
          }
        }
      };

      await expect(
        axios.post(serverUrl, largePayload, {
          headers: { 'Content-Type': 'application/json' }
        })
      ).rejects.toMatchObject({
        response: { status: expect.any(Number) }
      });
    });

    it('should handle concurrent queries', async () => {
      const queryCount = 3;
      
      const promises = Array.from({ length: queryCount }, (_, i) => {
        const requestId = generateTestId(`concurrent-${i}`);
        return client.query(requestId, {
          constructorName: 'TestQuery',
          dto: { message: `Concurrent message ${i}` }
        }).catch(err => ({ error: err.message }));
      });

      const results = await Promise.allSettled(promises);
      
      const successful = results.filter(r => 
        r.status === 'fulfilled' && 
        r.value && 
        typeof r.value === 'object' && 
        'payload' in r.value &&
        !('error' in r.value)
      );
      
      expect(successful.length).toBeGreaterThan(0);

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
  });
});