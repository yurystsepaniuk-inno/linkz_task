import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { MESSAGES } from '../common/messages';

const CARD_NUMBER_REGEX = /^[\d\s-]{13,23}$/;

/**
 * Caller proposes a seat + user; the price is resolved server-side from
 * `RESERVATION_AMOUNT`. There is no `amount` field by design — payment-api is
 * the single source of truth for seat pricing, so a misconfigured or
 * compromised caller cannot create a $0.01 session for a $10 seat.
 */
export class CreateSessionDto {
  @IsString()
  @IsNotEmpty()
  seatId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;
}

export class PayDto {
  @IsString()
  @IsNotEmpty()
  @Matches(CARD_NUMBER_REGEX, { message: MESSAGES.payment.invalidCardFormat })
  cardNumber: string;
}
