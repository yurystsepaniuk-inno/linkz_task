export const SEAT_STATUS = {
  AVAILABLE: 'AVAILABLE',
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
} as const;

export type SeatStatus = (typeof SEAT_STATUS)[keyof typeof SEAT_STATUS];
