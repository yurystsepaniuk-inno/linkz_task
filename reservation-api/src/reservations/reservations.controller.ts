import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ClerkAuthGuard, AuthenticatedRequest } from '../auth/clerk-auth.guard';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './reservation.dto';

@Controller('api/reservations')
@UseGuards(ClerkAuthGuard)
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateReservationDto, @Req() req: AuthenticatedRequest) {
    return this.reservationsService.create(dto, req.auth.userId);
  }

  /** Append-only payment audit trail for one of the caller's own reservations. */
  @Get(':id/audit')
  getAudit(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.reservationsService.getAudit(id, req.auth.userId);
  }
}
