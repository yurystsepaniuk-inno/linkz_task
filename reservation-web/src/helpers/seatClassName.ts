import { SEAT_STATUS } from '../consts';
import type { Seat } from '../types';

export function seatClassName(seat: Seat, selectedId: string | null): string {
  if (seat.id === selectedId && seat.status === SEAT_STATUS.AVAILABLE) {
    return 'seat seat--selected';
  }
  if (seat.status === SEAT_STATUS.AVAILABLE) return 'seat seat--available';
  return 'seat seat--occupied';
}
