import type { SeatStatus } from '../consts';

export interface Seat {
  id: string;
  status: SeatStatus;
}
