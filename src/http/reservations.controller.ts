import { Controller, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CapacityService } from '../capacity/capacity.service.js';
import { PG_POOL, type Db, withTransaction } from '../db/database.js';
import { ApiErrors } from '../docs/api-errors.decorator.js';
import { DomainError } from '../errors/error-table.js';
import { contextOf } from '../logging/request-context.js';
import { ReservationDto } from './dto.js';
import * as v from './validation.js';
import { reservationView } from './views.js';

@ApiTags('Reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(
    @Inject(CapacityService) private readonly capacity: CapacityService,
    @Inject(PG_POOL) private readonly pool: Db
  ) {}

  @Post(':reservationId/release')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'releaseReservation',
    summary: 'Release a reservation on repayment',
    description:
      'Gives back exactly the amount the reservation took, in the program currency: never reconverted at a new rate. ' +
      'Idempotent by state: releasing an already released reservation returns it unchanged.',
  })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: ReservationDto, description: 'Released (now, or earlier).' })
  @ApiErrors('invalid_request', 'reservation_not_found')
  async release(
    @Param('reservationId') rawId: string,
    @Res({ passthrough: true }) res: Response
  ): Promise<ReservationDto> {
    const ctx = contextOf(res);
    const id = v.reservationId(rawId);
    const result = await withTransaction(this.pool, (tx) =>
      this.capacity.release(tx, id, `http:${ctx.subject}`)
    );
    if (!result.ok) {
      throw new DomainError(result.kind);
    }
    ctx.programId = result.reservation.programId;
    ctx.outcome = result.alreadyReleased ? 'replayed' : 'released';
    return reservationView(result.reservation);
  }
}
