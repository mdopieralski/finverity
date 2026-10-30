// Wire shapes. These classes exist for the OpenAPI document (@nestjs/swagger reads the decorators);
// validation is done by hand in validation.ts, so the rules are explicit and dependency-free.
// Every amount is a decimal STRING of integer minor units: JSON numbers lose precision above 2^53.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ERROR_TABLE } from '../errors/error-table.js';
import { SUPPORTED_CURRENCIES } from '../money/currencies.js';
import { MINOR_AMOUNT_PATTERN } from '../money/money.js';

const amount = (description: string, example: string) =>
  ApiProperty({ type: 'string', pattern: MINOR_AMOUNT_PATTERN, example, description });

const signedAmount = (description: string, example: string) =>
  ApiProperty({ type: 'string', pattern: '^-?[0-9]{1,19}$', example, description });

const currency = (description: string, example: string) =>
  ApiProperty({ type: 'string', enum: SUPPORTED_CURRENCIES, example, description });

export class ReserveRequestDto {
  @ApiProperty({
    type: 'string',
    pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$',
    example: 'INV-1001',
    description: "The supplier invoice approved for early payment (the funder's reference).",
  })
  invoiceRef: string;

  @amount(
    'Invoice amount in integer minor units of `currency` (USD 12,500.00 = "1250000"; JPY has no minor unit).',
    '1250000'
  )
  amountMinor: string;

  @currency('Invoice currency. Converted once, now, into the program currency if they differ.', 'USD')
  currency: string;
}

export class InvoiceAmountDto {
  @amount('Invoice amount as submitted, in minor units of `currency`.', '1250000')
  amountMinor: string;

  @currency('Invoice currency.', 'USD')
  currency: string;
}

export class FxDto {
  @ApiProperty({
    type: 'string',
    example: '0.909091',
    description:
      'Program-currency units per one invoice-currency unit, as used. "1" when the currencies match.',
  })
  rate: string;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'When the rate was fixed.' })
  rateAt: string;

  @ApiProperty({ type: 'string', example: 'fixed-table', description: 'Where the rate came from.' })
  source: string;
}

export class ReservationDto {
  @ApiProperty({ type: 'string', format: 'uuid', example: '6f1c2a9e-3b0d-4c55-9a51-2f1f6a7c9d10' })
  id: string;

  @ApiProperty({ type: 'string', example: 'prg_eur_acme' })
  programId: string;

  @ApiProperty({ type: 'string', example: 'INV-1001' })
  invoiceRef: string;

  @ApiProperty({ type: 'string', enum: ['ACTIVE', 'RELEASED'], example: 'ACTIVE' })
  status: string;

  @amount(
    'Capacity taken, in minor units of the PROGRAM currency, rounded up. Release gives back exactly this.',
    '1136364'
  )
  amountMinor: string;

  @currency('Program currency.', 'EUR')
  currency: string;

  @ApiProperty({
    type: 'integer',
    example: 2,
    description: 'Minor-unit exponent of `currency` (2 for EUR, 0 for JPY).',
  })
  exponent: number;

  @ApiProperty({ type: () => InvoiceAmountDto })
  invoice: InvoiceAmountDto;

  @ApiProperty({ type: () => FxDto })
  fx: FxDto;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, example: null })
  releasedAt: string | null;
}

export class AvailabilityDto {
  @ApiProperty({ type: 'string', example: 'prg_eur_acme' })
  programId: string;

  @currency('Program currency: every amount below is in it.', 'EUR')
  currency: string;

  @ApiProperty({ type: 'integer', example: 2 })
  exponent: number;

  @signedAmount('Credit limit set by treasury.', '1000000000')
  creditLimitMinor: string;

  @signedAmount('Utilisation treasury reports from outside this service.', '0')
  treasuryUtilisedMinor: string;

  @signedAmount('Sum of ACTIVE reservations made through this service.', '1136364')
  reservedMinor: string;

  @signedAmount(
    'creditLimit − treasuryUtilised − reserved. Negative if treasury cut the limit below utilisation.',
    '998863636'
  )
  availableMinor: string;

  @ApiProperty({ type: 'string', example: '0', description: 'Last treasury sequence applied.' })
  treasurySequence: string;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description:
      'The instant this was computed for: null = now (current figures); set = folded from the ledger.',
  })
  asOf: string | null;
}

export class ReservationPageDto {
  @ApiProperty({ type: () => ReservationDto, isArray: true })
  items: ReservationDto[];

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: 'Pass as `cursor` to get the next page; null on the last page.',
  })
  nextCursor: string | null;
}

export class ErrorDetailDto {
  @ApiProperty({ type: 'string', enum: Object.keys(ERROR_TABLE), example: 'insufficient_capacity' })
  code: string;

  @ApiProperty({
    type: 'string',
    example: ERROR_TABLE.insufficient_capacity.message,
    description: 'A fixed string per code.',
  })
  message: string;

  @ApiProperty({
    type: 'string',
    example: '0b6d7f0e-4f2a-4a8e-9a3e-3c2a1d9b8e71',
    description: 'Echoed in X-Request-Id and the logs.',
  })
  requestId: string;

  @ApiPropertyOptional({
    type: 'string',
    isArray: true,
    example: ['amountMinor'],
    description: 'Offending field names (never their values).',
  })
  fields?: string[];
}

export class ErrorBodyDto {
  @ApiProperty({ type: () => ErrorDetailDto })
  error: ErrorDetailDto;
}
