import { Module } from '@nestjs/common';
import { SeatExpiryWorker } from './seat-expiry.worker';

@Module({
  providers: [SeatExpiryWorker],
})
export class CronModule {}
