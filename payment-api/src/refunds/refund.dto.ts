import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateRefundDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsString()
  @IsOptional()
  reason?: string;
}
