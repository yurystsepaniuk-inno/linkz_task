import { Injectable, Inject } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from './pg-pool.token';

/**
 * Single source of truth for `BEGIN / COMMIT / ROLLBACK`. Services that need a
 * transaction call `run(fn)` and receive a `PoolClient` to thread through
 * repository calls — repositories accept a `Queryable`, so the same method
 * works inside or outside a transaction.
 *
 * The ROLLBACK is `.catch(() => {})` so we never mask the real error if the
 * BEGIN itself failed (no transaction was opened → ROLLBACK warns "no
 * transaction in progress"). The original thrown error is re-thrown.
 */
@Injectable()
export class TransactionRunner {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async run<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
