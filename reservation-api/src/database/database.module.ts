import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL } from './pg-pool.token';
import { TransactionRunner } from './transaction.runner';

export { PG_POOL };

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          host: config.getOrThrow<string>('DB_HOST'),
          port: parseInt(config.getOrThrow<string>('DB_PORT'), 10),
          user: config.getOrThrow<string>('DB_USER'),
          password: config.getOrThrow<string>('DB_PASSWORD'),
          database: config.getOrThrow<string>('DB_NAME'),
        }),
    },
    TransactionRunner,
  ],
  exports: [PG_POOL, TransactionRunner],
})
export class DatabaseModule {}
