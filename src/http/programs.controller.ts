import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CapacityService } from '../capacity/capacity.service.js';
import { PG_POOL, type Db, withTransaction } from '../db/database.js';
import { ApiErrors } from '../docs/api-errors.decorator.js';
import { DomainError, type ErrorKind, isErrorKind } from '../errors/error-table.js';
import { claimKey, findStored, requestHash, storeResult } from '../idempotency/idempotency.store.js';
import { contextOf } from '../logging/request-context.js';
import { AvailabilityDto, ReservationDto, ReservationPageDto, ReserveRequestDto } from './dto.js';
import * as v from './validation.js';
import { availabilityView, reservationView } from './views.js';

const PROGRAM_ID_PARAM = ApiParam({
  name: 'programId',
  example: 'prg_eur_acme',
  schema: { pattern: '^prg_[a-z0-9_]{1,64}$' },
});

/** What a reserve call produced inside its transaction; turned into a response after COMMIT. */
type ReserveOutcome =
  { kind: 'conflict' } | { kind: 'done'; replayed: boolean; status: number; body: unknown };

@ApiTags('Programs')
@Controller('programs')
export class ProgramsController {
  constructor(
    @Inject(CapacityService) private readonly capacity: CapacityService,
    @Inject(PG_POOL) private readonly pool: Db
  ) {}

  @Post(':programId/reservations')
  @ApiOperation({
    operationId: 'createReservation',
    summary: 'Reserve capacity for an invoice approved for early payment',
    description: [
      'Converts the invoice amount into the program currency **once, now** (rounded up), stores the amount,',
      'the rate and its timestamp, and takes that much capacity. Never oversubscribes: the capacity check and',
      'the write are one atomic statement.',
      '',
      '**Idempotent:** send a unique `Idempotency-Key` per invoice approval. A retry with the same key and the',
      'same body returns the original response (`Idempotent-Replayed: true`), including a 422; the same key',
      'with a different body is a 409.',
    ].join('\n'),
  })
  @PROGRAM_ID_PARAM
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per reservation attempt, 1-255 printable ASCII characters. Scoped to the token subject.',
    schema: { type: 'string', maxLength: 255, example: 'approval-INV-1001' },
  })
  @ApiBody({ type: ReserveRequestDto })
  @ApiResponse({
    status: 201,
    description: 'Reserved (or the replay of an earlier 201).',
    type: ReservationDto,
  })
  @ApiErrors(
    'invalid_request',
    'invalid_amount',
    'idempotency_key_required',
    'program_not_found',
    'idempotency_key_reused',
    'insufficient_capacity',
    'fx_rate_unavailable'
  )
  async reserve(
    @Param('programId') rawProgramId: string,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) res: Response
  ): Promise<unknown> {
    const ctx = contextOf(res);
    const programId = v.programId(rawProgramId);
    ctx.programId = programId;
    const key = v.idempotencyKey(rawKey);
    const body = v.reserveBody(rawBody);
    const subject = ctx.subject as string;
    const hash = requestHash({
      programId,
      invoiceRef: body.invoiceRef,
      amountMinor: body.amountMinor.toString(),
      currency: body.currency,
    });

    // Priced before the transaction: program currency and FX rate are read first, so no lock or
    // connection waits on the rate source. Not stored under the key: nothing was reserved, and a missing
    // program or rate may exist on a retry.
    const priced = await this.capacity.price({ programId, ...body });
    // A key that already has an answer replays it, even if pricing would fail now.
    const earlier = priced.ok ? null : await findStored(this.pool, subject, key, hash);

    const outcome: ReserveOutcome = earlier
      ? earlier.state === 'replay'
        ? { kind: 'done', replayed: true, status: earlier.status, body: earlier.body }
        : { kind: 'conflict' }
      : await withTransaction<ReserveOutcome>(this.pool, async (tx) => {
          if (!priced.ok) {
            throw new DomainError(priced.kind);
          }
          const claim = await claimKey(tx, subject, key, hash);
          if (claim.state === 'conflict') {
            return { kind: 'conflict' };
          }
          if (claim.state === 'replay') {
            return { kind: 'done', replayed: true, status: claim.status, body: claim.body };
          }
          const result = await this.capacity.reserve(tx, priced.priced, `http:${subject}:${key}`);
          // Stored, including the 422: a key names one approval attempt, and its answer is final. A client
          // retrying after a timeout gets the answer that was given, not a different one minutes later; a new
          // approval attempt uses a new key.
          const stored = result.ok
            ? { status: 201, body: reservationView(result.reservation) }
            : { status: 422, body: { error: { code: result.kind } } };
          await storeResult(tx, subject, key, stored.status, stored.body);
          return { kind: 'done', replayed: false, ...stored };
        });

    if (outcome.kind === 'conflict') {
      throw new DomainError('idempotency_key_reused');
    }
    if (outcome.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    }
    const code = (outcome.body as { error?: { code?: unknown } }).error?.code;
    if (isErrorKind(code)) {
      throw new DomainError(code as ErrorKind);
    }
    ctx.outcome = outcome.replayed ? 'replayed' : 'reserved';
    res.status(outcome.status);
    return outcome.body;
  }

  @Get(':programId/availability')
  @ApiOperation({
    operationId: 'getAvailability',
    summary: 'Current availability, or availability at a past instant',
    description:
      'Without `asOf`: the current figures. With `asOf`: recomputed from the append-only ledger up to that instant, as an auditor would.',
  })
  @PROGRAM_ID_PARAM
  @ApiQuery({
    name: 'asOf',
    required: false,
    description: 'ISO-8601 instant with an offset, not in the future.',
    schema: { type: 'string', format: 'date-time', example: '2026-10-28T10:00:00Z' },
  })
  @ApiOkResponse({ type: AvailabilityDto })
  @ApiErrors('invalid_request', 'program_not_found')
  async availability(
    @Param('programId') rawProgramId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response
  ): Promise<AvailabilityDto> {
    const programId = v.programId(rawProgramId);
    contextOf(res).programId = programId;
    v.onlyQuery(query, ['asOf']);
    const result = await this.capacity.availability(programId, v.asOf(query.asOf));
    if (!result) {
      throw new DomainError('program_not_found');
    }
    contextOf(res).outcome = 'read';
    return availabilityView(result);
  }

  @Get(':programId/reservations')
  @ApiOperation({
    operationId: 'listReservations',
    summary: 'List a program’s reservations, newest first',
    description:
      'Keyset pagination: pass `nextCursor` back as `cursor`. Stable while new reservations arrive.',
  })
  @PROGRAM_ID_PARAM
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'RELEASED'] })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: { type: 'string' },
    description: 'Opaque, from `nextCursor`.',
  })
  @ApiOkResponse({ type: ReservationPageDto })
  @ApiErrors('invalid_request', 'program_not_found')
  async list(
    @Param('programId') rawProgramId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response
  ): Promise<ReservationPageDto> {
    const programId = v.programId(rawProgramId);
    contextOf(res).programId = programId;
    const page = v.pageQuery(query);
    const items = await this.capacity.list(programId, page);
    if (!items) {
      throw new DomainError('program_not_found');
    }
    const last = items.at(-1);
    contextOf(res).outcome = 'read';
    return {
      items: items.map(reservationView),
      nextCursor: last && items.length === page.limit ? v.encodeCursor(last.createdAt, last.id) : null,
    };
  }
}
