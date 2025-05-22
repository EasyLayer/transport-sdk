import { Client, ClientOptions } from '../client';
import { TransportFactory } from '../core/factory';
import { ITransport, Message } from '../core/transport';

// Mock the transport factory and transport
jest.mock('../core/factory');
jest.mock('../core/transport');

describe('Client', () => {
  let mockTransport: jest.Mocked<ITransport>;
  let client: Client;
  let options: ClientOptions;

  beforeEach(() => {
    // Setup mock transport
    mockTransport = {
      sendAndAwait: jest.fn(),
      subscribe: jest.fn(),
      destroy: jest.fn(),
    } as any;

    // Setup transport factory mock
    (TransportFactory.create as jest.Mock).mockReturnValue(mockTransport);

    // Setup client options
    options = {
      transport: {
        type: 'rpc',
        baseUrl: 'http://localhost:3000',
      },
    };

    client = new Client(options);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create transport using factory', () => {
      expect(TransportFactory.create).toHaveBeenCalledWith(options.transport);
    });
  });

  describe('request', () => {
    const testPayload = { constructorName: 'test', dto: {} };
    const testRequestId = '123';
    const testResponse = { result: 'success' };

    beforeEach(() => {
      mockTransport.sendAndAwait.mockResolvedValue(testResponse);
    });

    it('should throw error if requestId is missing', async () => {
      await expect(client.request('query', '', testPayload))
        .rejects
        .toThrow('requestId is required');
    });

    it('should throw error for unsupported action', async () => {
      await expect(client.request('unsupported' as any, testRequestId, testPayload))
        .rejects
        .toThrow('Unsupported action: unsupported');
    });

    it('should send query request and return response', async () => {
      const result = await client.request('query', testRequestId, testPayload);

      expect(mockTransport.sendAndAwait).toHaveBeenCalledWith({
        action: 'query',
        requestId: testRequestId,
        payload: testPayload,
      });
      expect(result).toEqual(testResponse);
    });
  });

  describe('subscribe', () => {
    const testConstructorName = 'TestEvent';
    const testCallback = jest.fn();
    const unsubscribe = jest.fn();

    beforeEach(() => {
      mockTransport.subscribe.mockReturnValue(unsubscribe);
    });

    it('should subscribe to events and return unsubscribe function', () => {
      const result = client.subscribe(testConstructorName, testCallback);

      expect(mockTransport.subscribe).toHaveBeenCalledWith(
        testConstructorName,
        testCallback
      );
      expect(result).toBe(unsubscribe);
    });
  });
}); 