import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { SessionsStore } from './sessions.store';

@Module({
  controllers: [CheckoutController],
  providers: [CheckoutService, SessionsStore],
})
export class CheckoutModule {}
