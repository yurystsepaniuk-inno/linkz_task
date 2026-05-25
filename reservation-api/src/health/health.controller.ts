import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/pg-pool.token';

/**
 * Liveness + shallow readiness probe. Returns 200 when the process is up
 * and the database round-trips a trivial SELECT — the only dependency a
 * compose/k8s probe needs to know about before sending real traffic.
 * Excluded from access logs in `app.module.ts` so probe traffic doesn't
 * drown out the signal stream.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        database: 'unreachable',
        error: (err as Error).message,
      });
    }
    return { status: 'ok', database: 'ok' };
  }
}
