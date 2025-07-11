import { Module, DynamicModule, Provider } from '@nestjs/common';
import { Client, ClientOptions } from './client';
import { ClientTransportOptions } from './core/factory';

export interface ClientModuleOptions {
  isGlobal?: boolean;
  transport: ClientTransportOptions;
}

export interface ClientModuleAsyncOptions {
  isGlobal?: boolean;
  useFactory?: (...args: any[]) => Promise<ClientOptions> | ClientOptions;
  inject?: any[];
  imports?: any[];
}

@Module({})
export class ClientModule {
  static forRoot(options: ClientModuleOptions): DynamicModule {
    const clientProvider: Provider = {
      provide: Client,
      useValue: new Client({ transport: options.transport }),
    };

    return {
      module: ClientModule,
      global: options.isGlobal || false,
      providers: [clientProvider],
      exports: [Client],
    };
  }

  static forRootAsync(options: ClientModuleAsyncOptions): DynamicModule {
    const clientProvider: Provider = {
      provide: Client,
      useFactory: async (...args: any[]) => {
        const config = await options.useFactory!(...args);
        return new Client(config);
      },
      inject: options.inject || [],
    };

    return {
      module: ClientModule,
      global: options.isGlobal || false,
      imports: options.imports || [],
      providers: [clientProvider],
      exports: [Client],
    };
  }
}
