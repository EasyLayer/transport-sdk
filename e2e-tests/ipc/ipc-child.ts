import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@easylayer/common/cqrs';
import { LoggerModule } from '@easylayer/common/logger';
import { TransportModule } from '@easylayer/common/network-transport';

import { 
  TestQueryHandler, 
  TestErrorQueryHandler, 
  TestStreamQueryHandler, 
  TestEventHandler 
} from '../mocks';

@Module({
  imports: [
    LoggerModule.forRoot({ 
      componentName: 'IPC.Child.Server',
    }),
    CqrsModule.forRoot({ isGlobal: true }),
    TransportModule.forRoot({
      isGlobal: true,
      transports: [
        {
          type: 'ipc',
          isEnabled: true,
          name: 'ipc-child-server',
          maxMessageSize: 1024 * 1024,
          heartbeatTimeout: 3000,
          connectionTimeout: 2000
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
export class IpcChildServerModule {}

async function bootstrap() {
  try {
    if (!process.send) {
      throw new Error('This script must be run as a child process with IPC');
    }

    const app = await NestFactory.create(IpcChildServerModule, {
      logger: false
    });

    await app.init();

    process.send({ 
      type: 'ready', 
      pid: process.pid,
      timestamp: Date.now()
    });

    const gracefulShutdown = async (signal: string) => {
      try {
        await app.close();
        process.exit(0);
      } catch (error) {
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('disconnect', () => gracefulShutdown('disconnect'));

    process.on('uncaughtException', (error) => {
      if (process.send) {
        process.send({ 
          type: 'error', 
          error: error.message,
          stack: error.stack
        });
      }
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      if (process.send) {
        process.send({ 
          type: 'error', 
          error: 'Unhandled promise rejection',
          reason: String(reason)
        });
      }
      process.exit(1);
    });

  } catch (error) {
    if (process.send) {
      process.send({ 
        type: 'startup_error', 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
    
    process.exit(1);
  }
}

bootstrap().catch((error) => {
  if (process.send) {
    process.send({
      type: 'startup_error',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
  process.exit(1);
});