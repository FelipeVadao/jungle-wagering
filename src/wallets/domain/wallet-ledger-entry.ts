import { DomainError } from '../../common/domain/domain-error';
import { Money } from '../../common/domain/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger. Imutável por construção: só campos `readonly`,
 * instância congelada e nenhum método de transição. O banco reforça a mesma
 * regra (trigger append-only + CHECK aritmético).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética do lançamento: balanceBefore ± money === balanceAfter. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);

    if (!entry.money.isPositive()) {
      throw new UnbalancedLedgerEntryError(
        'Ledger entry amount must be positive',
      );
    }

    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError(
        'Ledger entry cannot produce a negative balance',
      );
    }

    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        'balanceBefore ± money must equal balanceAfter',
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expected.equals(this.balanceAfter);
  }
}
