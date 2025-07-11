export interface BasePayload<DTO = any> {
  constructorName: string;
  dto: DTO;
}

export interface ErrorPayload {
  message?: string;
  error?: string;
  code?: string;
  errorCode?: string;
  statusCode?: number;
  [key: string]: any;
}

export interface BaseMessage<A extends string = string, P = any> {
  requestId?: string;
  action: A;
  payload?: P;
  timestamp?: number;
}

// Incoming actions (client -> server)
export type IncomingActions = 'query' | 'streamQuery' | 'ping' | 'pong';

// Outgoing actions (server -> client)
export type OutgoingActions =
  | 'queryResponse'
  | 'streamResponse'
  | 'streamEnd'
  | 'event'
  | 'eventsBatch'
  | 'error'
  | 'ping'
  | 'pong';

export interface IncomingMessage<A extends IncomingActions = IncomingActions, P = any> extends BaseMessage<A, P> {}

export interface OutgoingMessage<A extends OutgoingActions = OutgoingActions, P = any> extends BaseMessage<A, P> {}

// Specific message types for commonly used messages
export interface QueryMessage extends IncomingMessage<'query', BasePayload> {}
export interface StreamQueryMessage extends IncomingMessage<'streamQuery', BasePayload> {}
export interface QueryResponseMessage extends OutgoingMessage<'queryResponse', any> {}
export interface StreamResponseMessage extends OutgoingMessage<'streamResponse', any> {}
export interface StreamEndMessage extends OutgoingMessage<'streamEnd', void> {}
export interface EventMessage extends OutgoingMessage<'event', BasePayload> {}
export interface EventsBatchMessage extends OutgoingMessage<'eventsBatch', BasePayload[]> {}
export interface ErrorMessage extends OutgoingMessage<'error', ErrorPayload> {}
