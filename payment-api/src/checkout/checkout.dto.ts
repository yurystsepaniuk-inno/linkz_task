import { IsString, IsNotEmpty, IsNumber, IsPositive, Matches } from 'class-validator';
import { MESSAGES } from '../common/messages';

const CARD_NUMBER_REGEX = /^[\d\s-]{13,23}$/;

export class CreateSessionDto {
  @IsString()
  @IsNotEmpty()
  seatId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsNumber()
  @IsPositive()
  amount: number;
}

export class PayDto {
  @IsString()
  @IsNotEmpty()
  @Matches(CARD_NUMBER_REGEX, { message: MESSAGES.payment.invalidCardFormat })
  cardNumber: string;
}
