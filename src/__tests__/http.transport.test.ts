import axios from 'axios';
import { HttpTransport } from '../transports/http.transport';
import { Message } from '../core/transport';

const mockAxiosInstance = {
  post: jest.fn()
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockAxiosInstance)
}));

describe('HttpTransport', () => {
  let transport: HttpTransport;
  const testUrl = 'http://localhost:3000';
  const testMessage: Message = {
    action: 'query',
    requestId: '123',
    payload: {
      constructorName: 'TestPayload',
      dto: { data: 'test' }
    }
  };

  beforeEach(() => {
    transport = new HttpTransport({ type: 'http', baseUrl: testUrl });
    jest.clearAllMocks();
  });

  describe('sendAndAwait', () => {
    it('should send message and return response data', async () => {
      const testResponse = { result: 'success' };
      mockAxiosInstance.post.mockResolvedValue({ data: testResponse });

      const result = await transport.sendAndAwait(testMessage);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('', testMessage);
      expect(result).toEqual(testResponse);
    });

    it('should handle request errors', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('Network error'));

      await expect(transport.sendAndAwait(testMessage))
        .rejects
        .toThrow('HTTP transmit error: Error: Network error');
    });
  });

  describe('subscribe', () => {
    it('should return unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = transport.subscribe('TestEvent', callback);

      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    });
  });
}); 