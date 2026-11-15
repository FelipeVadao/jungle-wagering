import { Money } from '../../common/domain/money';

export class WalletAccount {
  private constructor(
    public readonly playerId: string,
    public readonly currency: string,
    private currentBalance: Money,
    private currentVersion: number,
  ) {}

  static create(playerId: string, currency: string): WalletAccount {
    if (!playerId.trim()) {
      throw new Error('Player ID is required');
    }

    const initialBalance = Money.fromDecimal('0.00', currency);

    return new WalletAccount(
      playerId,
      currency,
      initialBalance,
      0,
    );
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  credit(amount: Money): void {
    this.ensurePositiveAmount(amount);

    this.currentBalance = this.currentBalance.add(amount);
    this.currentVersion++;
  }

  debit(amount: Money): void {
    this.ensurePositiveAmount(amount);

    const newBalance = this.currentBalance.subtract(amount);

    if (newBalance.isNegative()) {
      throw new Error('Insufficient wallet balance');
    }

    this.currentBalance = newBalance;
    this.currentVersion++;
  }

  private ensurePositiveAmount(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new Error('Currency mismatch');
    }

    if (amount.compare(Money.fromDecimal('0.00', this.currency)) <= 0) {
      throw new Error('Amount must be greater than zero');
    }
  }
}
