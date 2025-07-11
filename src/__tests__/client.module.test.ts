import { Test, TestingModule } from '@nestjs/testing';
import { ClientModule } from '../client.module';
import { Client } from '../client';

describe('ClientModule', () => {
  afterEach(async () => {
    // Clean up any created modules
  });

  describe('forRoot', () => {
    it('should create module with Client provider', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          ClientModule.forRoot({
            transport: {
              type: 'http',
              baseUrl: 'http://localhost:3000',
            },
          }),
        ],
      }).compile();

      const client = module.get<Client>(Client);
      
      expect(client).toBeDefined();
      expect(client).toBeInstanceOf(Client);
      expect(client.transport.type).toBe('http');
      expect(client.transport.name).toBe('http');
    });

    it('should create global module when isGlobal is true', async () => {
      const dynamicModule = ClientModule.forRoot({
        isGlobal: true,
        transport: {
          type: 'http',
          baseUrl: 'http://localhost:3000',
        },
      });

      expect(dynamicModule.global).toBe(true);
      expect(dynamicModule.module).toBe(ClientModule);
      expect(dynamicModule.providers).toHaveLength(1);
      expect(dynamicModule.exports).toEqual([Client]);
    });
  });

  describe('forRootAsync', () => {
    it('should create module with async Client provider', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          ClientModule.forRootAsync({
            useFactory: () => ({
              transport: {
                type: 'http',
                baseUrl: 'http://localhost:3001',
              },
            }),
          }),
        ],
      }).compile();

      const client = module.get<Client>(Client);
      
      expect(client).toBeDefined();
      expect(client).toBeInstanceOf(Client);
      expect(client.transport.type).toBe('http');
    });

    it('should create global async module', async () => {
      const dynamicModule = ClientModule.forRootAsync({
        isGlobal: true,
        useFactory: () => ({
          transport: {
            type: 'http',
            baseUrl: 'http://localhost:3000',
          },
        }),
      });

      expect(dynamicModule.global).toBe(true);
      expect(dynamicModule.module).toBe(ClientModule);
      expect(dynamicModule.providers).toHaveLength(1);
      expect(dynamicModule.exports).toEqual([Client]);
    });
  });
});