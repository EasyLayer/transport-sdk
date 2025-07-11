import { MessageSizeError } from './errors';

export const validateMessageSize = (data: any, maxSize: number, transportType: string, transportName: string): void => {
  const serialized = JSON.stringify(data);
  const size = Buffer.byteLength(serialized, 'utf8');

  if (size > maxSize) {
    throw new MessageSizeError(`Message size ${size} bytes exceeds limit of ${maxSize} bytes`, size, maxSize, {
      transportType,
      transportName,
    });
  }
};
