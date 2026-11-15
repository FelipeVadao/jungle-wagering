import { DomainError } from '../../common/domain/domain-error';
import { CurrencyMismatchError, Money } from '../../common/domain/money';

import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = 'INVALID_WALLET_OPERATION';
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Id da transação interna OPENING que origina o crédito de abertura. */
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** null quando o saldo inicial é zero (nada a lançar). */
  openingEntry: WalletLedgerEntry | null;
}

export interface BalanceMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  now: Date;
}

/**
 * Aggregate root da carteira.
 *
 * Toda alteração de saldo produz exatamente um `WalletLedgerEntry` com a
 * mesma aritmética, e `version` só incrementa quando o saldo muda.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a carteira com `version = 1`. O saldo inicial positivo vem
   * acompanhado do lançamento CREDIT de abertura, que deve ser persistido na
   * mesma transação SQL.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (!props.playerId.trim()) {
      throw new InvalidWalletOperationError('playerId is required');
    }

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(
        'Initial balance cannot be negative',
      );
    }

    const zero = Money.zero(props.initialBalance.currency);

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );

    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: zero,
          balanceAfter: props.initialBalance,
          createdAt: props.now,
        })
      : null;

    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  belongsTo(playerId: string): boolean {
    return this.playerId === playerId;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);

    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(
        `Insufficient funds in wallet ${this.id}`,
      );
    }

    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(
    direction: LedgerDirection,
    movement: BalanceMovement,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);

    // A factory valida a aritmética e a não-negatividade antes de mutar.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.now;

    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);

    if (!money.isPositive()) {
      throw new InvalidWalletOperationError(
        'Movement amount must be greater than zero',
      );
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Wallet currency is ${this.currency}, operation currency is ${money.currency}`,
      );
    }
  }
}
