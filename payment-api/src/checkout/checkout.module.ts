import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { SessionsStore } from './sessions.store';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  controllers: [CheckoutController],
  providers: [CheckoutService, SessionsStore, ApiKeyGuard],
})
export class CheckoutModule {}
