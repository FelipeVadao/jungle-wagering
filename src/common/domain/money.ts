import { DomainError } from './domain-error';

/** Formato de contrato (HTTP, SQS, eventos): string decimal com escala 2. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

const SCALE = 2;
const MINOR_UNITS_PER_UNIT = 100n;

/**
 * Até 18 dígitos inteiros e no máximo 2 casas decimais: casa com a coluna
 * `numeric(20,2)`. Sem sinal, sem expoente, sem espaços, sem zeros à esquerda.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Internamente usa `bigint` em unidades mínimas
 * (centavos), então nenhuma operação passa por ponto flutuante.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Factory de contrato: rejeita `number`, NaN, Infinity, notação científica,
   * string vazia, mais de 2 casas e valores negativos.
   * "25", "25.5" e "25.50" são aceitos e normalizados para "25.00"/"25.50".
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object');
    }

    const currency = Money.parseCurrency(props.currency);

    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('Money amount must be a decimal string');
    }

    const match = AMOUNT_PATTERN.exec(props.amount);

    if (!match) {
      throw new InvalidMoneyError(
        `Invalid amount "${props.amount}": expected a non-negative decimal string with at most ${SCALE} decimal places`,
      );
    }

    const [, whole, fraction = ''] = match;
    const minorUnits =
      BigInt(whole) * MINOR_UNITS_PER_UNIT +
      BigInt(fraction.padEnd(SCALE, '0'));

    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits > other.minorUnits;
  }

  /** Igualdade de valor: moedas diferentes nunca são iguais (não lança). */
  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  /** Valor decimal com escala fixa de 2 casas, ex.: "25.00" ou "-3.10". */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const whole = absolute / MINOR_UNITS_PER_UNIT;
    const fraction = (absolute % MINOR_UNITS_PER_UNIT)
      .toString()
      .padStart(SCALE, '0');

    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Cannot operate ${this.currency} with ${other.currency}`,
      );
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        'Currency must be an ISO-4217 code (3 uppercase letters)',
      );
    }

    return currency;
  }
}
