import type { PaymentResult } from '../consts';

export interface SessionData {
  seatId: string;
  amount: number;
}

export interface PayResponse {
  status: PaymentResult;
  webhookDelivered: boolean;
}
