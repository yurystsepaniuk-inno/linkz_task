import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { SeatStatus } from '../common/constants';

export interface Seat {
  id: string;
  status: SeatStatus;
}

@Injectable()
export class SeatsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findAll(): Promise<Seat[]> {
    const result = await this.pool.query<Seat>('SELECT id, status FROM seats ORDER BY id');
    return result.rows;
  }
}
