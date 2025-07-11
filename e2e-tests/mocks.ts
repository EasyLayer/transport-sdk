import { IQuery, IQueryHandler, QueryHandler, IEvent, EventsHandler, IEventHandler, EventBus } from '@easylayer/common/cqrs';

// Test Query Classes
export class TestQuery implements IQuery {
  constructor(public readonly message: string, public readonly delay?: number) {}
}

export class TestErrorQuery implements IQuery {
  constructor(public readonly errorMessage: string) {}
}

export class TestStreamQuery implements IQuery {
  constructor(public readonly count: number, public readonly delay?: number) {}
}

export class TestEvent implements IEvent {
  constructor(
    public readonly id: string, 
    public readonly data: string, 
    public readonly timestamp: number = Date.now()
  ) {}
}

// Query Handlers with correct payload extraction
@QueryHandler(TestQuery)
export class TestQueryHandler implements IQueryHandler<TestQuery> {
  constructor(private readonly eventBus: EventBus) {}

  async execute(query: TestQuery): Promise<{ result: string; timestamp: number }> {
    const dto = (query as any).payload;
    const message = dto?.message || 'undefined';
    const delay = dto?.delay;
    
    if (delay) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    const event = new TestEvent(`query-${Date.now()}`, `Query executed: ${message}`);
    this.eventBus.publish(event).catch(() => {});
    
    return {
      result: `Echo: ${message}`,
      timestamp: Date.now()
    };
  }
}

@QueryHandler(TestErrorQuery)
export class TestErrorQueryHandler implements IQueryHandler<TestErrorQuery> {
  async execute(query: TestErrorQuery): Promise<never> {
    const dto = (query as any).payload;
    const errorMessage = dto?.errorMessage || 'Unknown error';
    throw new Error(errorMessage);
  }
}

@QueryHandler(TestStreamQuery)
export class TestStreamQueryHandler implements IQueryHandler<TestStreamQuery> {
  async execute(query: TestStreamQuery): Promise<AsyncGenerator<{ index: number; timestamp: number }, void, unknown>> {
    const dto = (query as any).payload;
    const count = dto?.count || 0;
    const delay = dto?.delay || 50;
    
    return this.createStream(count, delay);
  }

  private async *createStream(count: number, delay: number): AsyncGenerator<{ index: number; timestamp: number }, void, unknown> {
    for (let i = 0; i < count; i++) {
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      yield { index: i, timestamp: Date.now() };
    }
  }
}

@EventsHandler(TestEvent)
export class TestEventHandler implements IEventHandler<TestEvent> {
  handle(event: TestEvent): void | Promise<void> {
    return Promise.resolve();
  }
}