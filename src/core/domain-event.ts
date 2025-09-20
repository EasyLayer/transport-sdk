import type { WireEventRecord } from './transport';

export interface DomainEvent {
  aggregateId?: string;
  requestId?: string;
  blockHeight?: number;
  timestamp?: number;
  payload: any;
}

/** Build an object whose constructor name matches wire.eventType for string-based subscriptions. */
export function createDomainEventFromWire(wire: WireEventRecord): DomainEvent {
  const body = typeof wire.payload === 'string' ? safeParse(wire.payload as string) : wire.payload;

  const eventType = wire.eventType || wire.type || 'UnknownEvent';
  const EventCtor: any = function () {};
  Object.defineProperty(EventCtor, 'name', { value: eventType, configurable: true });

  const event: DomainEvent = {
    aggregateId: wire.aggregateId,
    requestId: wire.requestId,
    blockHeight: wire.blockHeight,
    timestamp: wire.timestamp,
    payload: body,
  };

  const instance = Object.assign(Object.create(EventCtor.prototype), event);
  Object.defineProperty(instance, 'constructor', { value: EventCtor, writable: false, enumerable: false });
  return instance;
}

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
