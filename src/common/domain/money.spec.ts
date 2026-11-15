import { Money } from './money';

describe('Money', () => {
  it('should add monetary values exactly', () => {
    const first = Money.fromDecimal('0.10');
    const second = Money.fromDecimal('0.20');

    expect(first.add(second).toDecimalString()).toBe('0.30');
  });

  it('should subtract monetary values exactly', () => {
    const first = Money.fromDecimal('100.00');
    const second = Money.fromDecimal('30.50');

    expect(first.subtract(second).toDecimalString()).toBe('69.50');
  });

  it('should reject different currencies', () => {
    const brl = Money.fromDecimal('100.00', 'BRL');
    const usd = Money.fromDecimal('100.00', 'USD');

    expect(() => brl.add(usd)).toThrow();
  });

  it('should reject invalid decimal values', () => {
    expect(() => Money.fromDecimal('10.999')).toThrow();
  });
});
