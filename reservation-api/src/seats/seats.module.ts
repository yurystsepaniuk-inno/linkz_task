import { Module } from '@nestjs/common';
import { SeatsController } from './seats.controller';
import { SeatsService } from './seats.service';
import { SeatsRepository } from './seats.repository';

@Module({
  controllers: [SeatsController],
  providers: [SeatsService, SeatsRepository],
})
export class SeatsModule {}
