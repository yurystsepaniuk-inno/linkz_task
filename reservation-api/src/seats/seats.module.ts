import { Module } from '@nestjs/common';
import { SeatsController } from './seats.controller';
import { SeatsService } from './seats.service';

@Module({
  controllers: [SeatsController],
  providers: [SeatsService],
})
export class SeatsModule {}
