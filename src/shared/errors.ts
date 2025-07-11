/**
 * Base transport error class with additional context.
 */
export class TransportError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly transportType?: string;
  public readonly transportName?: string;
  public readonly context?: Record<string, any>;

  constructor(
    message: string,
    code: string,
    options?: {
      transportType?: string;
      transportName?: string;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    this.transportType = options?.transportType;
    this.transportName = options?.transportName;
    this.context = options?.context;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    if (options?.cause && 'cause' in Error.prototype) {
      (this as any).cause = options.cause;
    }
  }

  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      timestamp: this.timestamp.toISOString(),
      transportType: this.transportType,
      transportName: this.transportName,
      context: this.context,
      stack: this.stack,
    };
  }
}

export class ConnectionError extends TransportError {
  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message, 'CONNECTION_ERROR', options);
  }
}

export class TimeoutError extends TransportError {
  public readonly timeoutMs: number;
  public readonly requestId?: string;
  public readonly action?: string;

  constructor(
    message: string,
    timeoutMs: number,
    options?: {
      transportType?: string;
      transportName?: string;
      requestId?: string;
      action?: string;
      context?: Record<string, any>;
    }
  ) {
    super(message, 'TIMEOUT_ERROR', options);
    this.timeoutMs = timeoutMs;
    this.requestId = options?.requestId;
    this.action = options?.action;
  }
}

export class MessageError extends TransportError {
  public readonly messageData?: any;

  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      messageData?: any;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message, 'MESSAGE_ERROR', options);
    this.messageData = options?.messageData;
  }
}

export class TransportInitError extends TransportError {
  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message, 'TRANSPORT_INIT_ERROR', options);
  }
}

export class ServerError extends TransportError {
  public readonly serverCode?: string;
  public readonly serverMessage?: string;
  public readonly statusCode?: number;

  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      serverCode?: string;
      serverMessage?: string;
      statusCode?: number;
      context?: Record<string, any>;
    }
  ) {
    super(message, 'SERVER_ERROR', options);
    this.serverCode = options?.serverCode;
    this.serverMessage = options?.serverMessage;
    this.statusCode = options?.statusCode;
  }
}

export class BadRequestError extends TransportError {
  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message, 'BAD_REQUEST', options);
  }
}

export class NotFoundError extends TransportError {
  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message, 'NOT_FOUND', options);
  }
}

export class ClientNotFoundError extends TransportError {
  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message, 'CLIENT_NOT_FOUND', options);
  }
}

export class MessageSizeError extends TransportError {
  public readonly actualSize: number;
  public readonly maxSize: number;

  constructor(
    message: string,
    actualSize: number,
    maxSize: number,
    options?: {
      transportType?: string;
      transportName?: string;
      context?: Record<string, any>;
    }
  ) {
    super(message, 'MESSAGE_SIZE_ERROR', options);
    this.actualSize = actualSize;
    this.maxSize = maxSize;
  }
}

export class SubscriptionError extends TransportError {
  public readonly constructorName?: string;

  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      constructorName?: string;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message, 'SUBSCRIPTION_ERROR', options);
    this.constructorName = options?.constructorName;
  }
}

export class DestroyError extends TransportError {
  constructor(
    message: string,
    options?: {
      transportType?: string;
      transportName?: string;
      context?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message, 'DESTROY_ERROR', options);
  }
}
