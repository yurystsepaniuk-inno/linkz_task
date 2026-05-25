import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import { SeatStatus } from '../common/constants';

export interface Seat {
  id: string;
  status: SeatStatus;
}

@Injectable()
export class SeatsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findAll(db: Queryable = this.pool): Promise<Seat[]> {
    const { rows } = await db.query<Seat>('SELECT id, status FROM seats ORDER BY id');
    return rows;
  }
}
