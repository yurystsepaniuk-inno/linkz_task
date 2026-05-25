import type { DeliveryStatus } from '../consts';

export interface DeliveryStatusBody {
  status: DeliveryStatus;
  terminalDelivered: boolean;
}
