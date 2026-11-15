export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  static fromDecimal(value: string, currency = 'BRL'): Money {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error('Invalid currency');
    }

    const match = /^(-?)(0|[1-9]\d*)\.(\d{2})$/.exec(value);

    if (!match) {
      throw new Error('Invalid monetary value. Use format 0.00');
    }

    const [, sign, whole, fraction] = match;

    const cents = BigInt(whole) * 100n + BigInt(fraction);
    const signedCents = sign === '-' ? -cents : cents;

    return new Money(signedCents, currency);
  }

  add(other: Money): Money {
    this.ensureSameCurrency(other);

    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.ensureSameCurrency(other);

    return new Money(this.cents - other.cents, this.currency);
  }

  compare(other: Money): number {
    this.ensureSameCurrency(other);

    if (this.cents < other.cents) return -1;
    if (this.cents > other.cents) return 1;

    return 0;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  toDecimalString(): string {
    const negative = this.cents < 0n;
    const absolute = negative ? -this.cents : this.cents;

    const whole = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');

    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  private ensureSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error('Cannot operate with different currencies');
    }
  }
}
