// Domain → wire. Amounts become decimal strings here and nowhere else.
import type { Availability, Reservation } from '../capacity/capacity.types.js';
import { exponentOf } from '../money/currencies.js';
import type { AvailabilityDto, ReservationDto } from './dto.js';

export function reservationView(r: Reservation): ReservationDto {
  return {
    id: r.id,
    programId: r.programId,
    invoiceRef: r.invoiceRef,
    status: r.status,
    amountMinor: r.amountMinor.toString(),
    currency: r.currency,
    exponent: exponentOf(r.currency),
    invoice: { amountMinor: r.invoiceAmountMinor.toString(), currency: r.invoiceCurrency },
    fx: { rate: r.fxRate, rateAt: r.fxRateAt.toISOString(), source: r.fxSource },
    createdAt: r.createdAt.toISOString(),
    releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
  };
}

export function availabilityView(a: Availability): AvailabilityDto {
  return {
    programId: a.programId,
    currency: a.currency,
    exponent: exponentOf(a.currency),
    creditLimitMinor: a.creditLimitMinor.toString(),
    treasuryUtilisedMinor: a.treasuryUtilisedMinor.toString(),
    reservedMinor: a.reservedMinor.toString(),
    availableMinor: a.availableMinor.toString(),
    treasurySequence: a.treasurySequence.toString(),
    asOf: a.asOf ? a.asOf.toISOString() : null,
  };
}
