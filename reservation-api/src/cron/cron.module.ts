import { Module } from '@nestjs/common';
import { SeatExpiryWorker } from './seat-expiry.worker';
import { ReconciliationWorker } from './reconciliation.worker';
import { SeatExpiryRepository } from './seat-expiry.repository';
import { ReconciliationRepository } from './reconciliation.repository';

@Module({
  providers: [
    SeatExpiryWorker,
    ReconciliationWorker,
    SeatExpiryRepository,
    ReconciliationRepository,
  ],
})
export class CronModule {}
