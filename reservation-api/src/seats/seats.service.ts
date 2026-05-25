import { Injectable } from '@nestjs/common';
import { SeatsRepository, Seat } from './seats.repository';

export { Seat };

@Injectable()
export class SeatsService {
  constructor(private readonly seats: SeatsRepository) {}

  async findAll(): Promise<Seat[]> {
    return this.seats.findAll();
  }
}
