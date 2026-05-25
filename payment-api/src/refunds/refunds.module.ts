import { Module } from '@nestjs/common';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';
import { RefundsRepository } from './refunds.repository';
import { CheckoutModule } from '../checkout/checkout.module';

@Module({
  // `CheckoutModule` re-exports `SessionsRepository` so refunds can read the
  // session's PAID/FAILED lifecycle status without re-providing the repo.
  imports: [CheckoutModule],
  controllers: [RefundsController],
  providers: [RefundsService, RefundsRepository],
})
export class RefundsModule {}
