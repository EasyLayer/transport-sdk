import { TransportError, ConnectionError, TimeoutError, ServerError } from './errors';
import type { ErrorPayload } from './message.interface';

export class ErrorUtils {
  static isTransportError(error: any): error is TransportError {
    return error instanceof TransportError;
  }

  static isRecoverable(error: any): boolean {
    if (!ErrorUtils.isTransportError(error)) {
      return false;
    }

    return error instanceof ConnectionError || error instanceof TimeoutError;
  }

  static getErrorInfo(error: any): Record<string, any> {
    if (ErrorUtils.isTransportError(error)) {
      return error.toJSON();
    }

    return {
      name: error?.name || 'Error',
      message: error?.message || 'Unknown error',
      stack: error?.stack,
      timestamp: new Date().toISOString(),
    };
  }

  static toErrorPayload(error: any): ErrorPayload {
    const info = ErrorUtils.getErrorInfo(error);

    return {
      error: info.message,
      code: info.code || 'UNKNOWN_ERROR',
      message: info.message,
      statusCode: (error as any).statusCode || 500,
      timestamp: info.timestamp,
    };
  }

  static fromErrorPayload(payload: ErrorPayload, transportInfo?: { type?: string; name?: string }): Error {
    const message = payload.message || payload.error || 'Unknown server error';

    return new ServerError(message, {
      transportType: transportInfo?.type,
      transportName: transportInfo?.name,
      serverCode: payload.code || payload.errorCode,
      serverMessage: payload.message || payload.error,
      statusCode: payload.statusCode,
      context: { originalPayload: payload },
    });
  }
}
