import { Module, Global } from '@nestjs/common';
import { PaymentAuditRepository } from './payment-audit.repository';

/**
 * Global so the audit ledger can be written from anywhere a payment-related
 * event occurs — reservations, webhooks, and the expiry cron — without each
 * feature module re-importing it.
 */
@Global()
@Module({
  providers: [PaymentAuditRepository],
  exports: [PaymentAuditRepository],
})
export class AuditModule {}
