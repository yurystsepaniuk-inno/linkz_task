import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Cross-cutting authentication primitives. `ApiKeyGuard` is the shared
 * `x-api-key` check used by both checkout (service-to-service status reads)
 * and refunds (reconciliation cron POSTs from reservation-api). Imported
 * from a neutral module so neither feature module owns the auth surface.
 */
@Module({
  providers: [ApiKeyGuard],
  exports: [ApiKeyGuard],
})
export class AuthModule {}
