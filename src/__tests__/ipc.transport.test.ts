import { IpcTransport } from '../transports/ipc.transport';
import { Message, Payload } from '../core/transport';
import { ChildProcess } from 'child_process';

describe('IpcTransport', () => {
  let transport: IpcTransport;
  let mockChild: Partial<ChildProcess> & {
    send: jest.Mock;
    on: jest.Mock;
    off: jest.Mock;
  };
  let messageHandler: (message: any) => void;

  const testMessage: Message = {
    action: 'query',
    requestId: '123',
    payload: {
      constructorName: 'TestPayload',
      dto: { data: 'test' }
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    messageHandler = jest.fn();
    
    mockChild = {
      send: jest.fn().mockImplementation((msg, callback) => {
        if (callback) callback(null);
        return true;
      }),
      on: jest.fn().mockImplementation((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
        }
        return mockChild as ChildProcess;
      }),
      off: jest.fn().mockReturnValue(mockChild as ChildProcess),
      connected: true
    };

    transport = new IpcTransport({ type: 'ipc', child: mockChild as ChildProcess });
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // describe('sendAndAwait', () => {
  //   const testResponse = { result: 'success' };

  //   it('should send message and wait for response', async () => {
  //     const responsePromise = await transport.sendAndAwait(testMessage);
      
  //     console.log('Mock calls structure:', {
  //       calls: mockChild.send.mock.calls,
  //       firstCall: mockChild.send.mock.calls[0],
  //       firstCallFirstArg: mockChild.send.mock.calls[0]?.[0],
  //       firstCallSecondArg: mockChild.send.mock.calls[0]?.[1],
  //     });
      
  //     // Get the correlationId from the sent message
  //     const sentMessage = mockChild.send.mock.calls[0][0];
      
  //     // Simulate response with matching correlationId
  //     messageHandler({ 
  //       action: 'queryResponse', 
  //       requestId: testMessage.requestId,
  //       correlationId: sentMessage.correlationId,
  //       payload: {
  //         constructorName: 'TestResponse',
  //         dto: testResponse
  //       }
  //     });

  //     const result = await responsePromise;
  //     expect(mockChild.send).toHaveBeenCalledWith(
  //       expect.objectContaining({
  //         action: testMessage.action,
  //         requestId: testMessage.requestId,
  //         payload: testMessage.payload
  //       }),
  //       expect.any(Function)
  //     );
  //     expect(result).toEqual(testResponse);
  //   });

  //   it('should handle timeout', async () => {
  //     const responsePromise = transport.sendAndAwait(testMessage);
      
  //     // Advance time by timeout duration
  //     jest.advanceTimersByTime(300000);

  //     await expect(responsePromise)
  //       .rejects
  //       .toThrow('Timeout waiting for');
  //   });
  // });

  // describe('subscribe', () => {
  //   it('should add listener and return unsubscribe function', async () => {
  //     const callback = jest.fn();
  //     const unsubscribe = transport.subscribe('TestEvent', callback);

  //     // Simulate event message
  //     messageHandler({
  //       action: 'event',
  //       payload: {
  //         constructorName: 'TestEvent',
  //         dto: { data: 'test' }
  //       }
  //     });

  //     // Wait for event processing
  //     await Promise.resolve();

  //     expect(callback).toHaveBeenCalledWith({ data: 'test' });
  //     expect(typeof unsubscribe).toBe('function');

  //     // Test unsubscribe
  //     unsubscribe();
  //     callback.mockClear();
      
  //     // Simulate another event
  //     messageHandler({
  //       action: 'event',
  //       payload: {
  //         constructorName: 'TestEvent',
  //         dto: { data: 'test2' }
  //       }
  //     });

  //     // Wait for event processing
  //     await Promise.resolve();

  //     expect(callback).not.toHaveBeenCalled();
  //   });
  // });

  describe('destroy', () => {
    it('should remove all listeners', async () => {
      await transport.destroy();
      expect(mockChild.off).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });
}); 