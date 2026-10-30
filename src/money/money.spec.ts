import { convertMinor, parseMinor, parseRate } from './money.js';

describe('parseMinor', () => {
  it('accepts positive integer strings that fit in BIGINT', () => {
    expect(parseMinor('1')).toBe(1n);
    expect(parseMinor('1250000')).toBe(1_250_000n);
    expect(parseMinor('922337203685477580')).toBe(922_337_203_685_477_580n);
  });

  it.each([
    ['fraction', '1500.50'],
    ['zero', '0'],
    ['negative', '-1'],
    ['exponent', '1e5'],
    ['leading zero', '01'],
    ['space', ' 1'],
    ['empty', ''],
    ['too long', '1'.repeat(19)],
  ])('rejects %s', (_name, v) => {
    expect(parseMinor(v)).toBeNull();
  });

  it('rejects JSON numbers: amounts must be strings', () => {
    expect(parseMinor(1500)).toBeNull();
    expect(parseMinor(1500.5)).toBeNull();
  });
});

describe('parseRate', () => {
  it('parses exact fractions', () => {
    expect(parseRate('0.909091')).toEqual({ numerator: 909_091n, denominator: 1_000_000n });
    expect(parseRate('150')).toEqual({ numerator: 150n, denominator: 1n });
  });

  it.each(['0', '-1', '1e3', '.5', '1.1234567890123'])('rejects %s', (v) => {
    expect(() => parseRate(v)).toThrow();
  });
});

describe('convertMinor', () => {
  it('same currency at rate 1 is the identity', () => {
    expect(convertMinor(1_250_000n, 2, 2, parseRate('1'))).toBe(1_250_000n);
  });

  it('USD 12,500.00 → EUR at 0.909091 rounds up to the next cent', () => {
    // 1,250,000 × 0.909091 = 1,136,363.75 → 1,136,364
    expect(convertMinor(1_250_000n, 2, 2, parseRate('0.909091'))).toBe(1_136_364n);
  });

  it('EUR → JPY shifts the exponent down (JPY has no minor unit)', () => {
    // EUR 100.00 at 162.5 JPY/EUR = ¥16,250
    expect(convertMinor(10_000n, 2, 0, parseRate('162.5'))).toBe(16_250n);
  });

  it('JPY → USD shifts the exponent up and rounds up', () => {
    // ¥1,000 at 0.006667 USD/JPY = USD 6.667 → 667 cents
    expect(convertMinor(1_000n, 0, 2, parseRate('0.006667'))).toBe(667n);
  });

  it('a 12-decimal rate and an amount near BIGINT max stay exact', () => {
    const amount = 900_000_000_000_000_000n;
    expect(convertMinor(amount, 2, 2, parseRate('1.000000000001'))).toBe(900_000_000_000_900_000n);
  });

  it('never rounds down to zero', () => {
    expect(convertMinor(1n, 2, 2, parseRate('0.000001'))).toBe(1n);
  });
});
