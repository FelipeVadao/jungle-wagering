import { Money } from '../../common/domain/money';
import { Wallet } from '../../wallets/domain/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../wallets/domain/wallet-ledger-entry';

import { RetryPolicy } from '../../common/domain/retry-policy';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionStatus,
} from './wager-transaction';

export type SettlementOutcome =
  | {
      type: 'processed';
      /** null quando a operação não move saldo (LOSS). */
      ledgerEntry: WalletLedgerEntry | null;
      balanceBefore: Money;
    }
  | { type: 'rejected'; failureCode: FailureCode }
  | { type: 'pending-reference' };

export interface SettlementInput {
  /** Wallet já bloqueada (FOR UPDATE) pela transação SQL corrente. */
  wallet: Wallet;
  /** Transação em PENDING (primeira chegada) ou PENDING_REFERENCE (worker). */
  transaction: WagerTransaction;
  /** Referência resolvida por (providerId, referenceExternalTransactionId). */
  reference: WagerTransaction | null;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para a referência. */
  referenceAlreadyReversed: boolean;
  retryPolicy: RetryPolicy;
  ledgerEntryId: string;
  now: Date;
}

/**
 * Regras de negócio da seção 7, puras e determinísticas: decidem o destino da
 * transação e aplicam o efeito no aggregate Wallet. Persistência, locks e
 * eventos ficam com a camada de aplicação.
 */
export function settleWagerTransaction(
  input: SettlementInput,
): SettlementOutcome {
  const { wallet, transaction, reference, now } = input;

  const reject = (failureCode: FailureCode): SettlementOutcome => {
    transaction.reject(failureCode, now, wallet.balance);
    return { type: 'rejected', failureCode };
  };

  if (transaction.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (!wallet.belongsTo(transaction.playerId)) {
    return reject(FailureCode.WalletPlayerMismatch);
  }

  if (transaction.hasReference()) {
    const referenceIsWaiting =
      !reference ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference;

    if (referenceIsWaiting) {
      const status = transaction.markPendingReference(
        now,
        input.retryPolicy,
        wallet.balance,
      );

      return status === WagerTransactionStatus.Rejected
        ? { type: 'rejected', failureCode: FailureCode.ReferenceNotFound }
        : { type: 'pending-reference' };
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }

    const sameContext =
      reference.providerId === transaction.providerId &&
      reference.walletId === wallet.id &&
      reference.playerId === transaction.playerId &&
      reference.money.currency === transaction.money.currency &&
      reference.roundId === transaction.roundId;

    if (!sameContext) {
      return reject(FailureCode.ReferenceMismatch);
    }

    if (!transaction.canReference(reference.kind)) {
      return reject(FailureCode.InvalidReferenceKind);
    }

    if (transaction.isReversal()) {
      if (!reference.money.equals(transaction.money)) {
        return reject(FailureCode.ReversalAmountMismatch);
      }

      if (input.referenceAlreadyReversed) {
        return reject(FailureCode.ReferenceAlreadyReversed);
      }
    }
  }

  const balanceBefore = wallet.balance;
  const direction = transaction.ledgerDirectionFor(reference ?? undefined);

  if (direction === null) {
    transaction.markProcessed(reference?.id, now, wallet.balance);
    return { type: 'processed', ledgerEntry: null, balanceBefore };
  }

  const movement = {
    entryId: input.ledgerEntryId,
    transactionId: transaction.id,
    money: transaction.money,
    now,
  };

  let ledgerEntry: WalletLedgerEntry;

  if (direction === LedgerDirection.Debit) {
    if (!wallet.canDebit(transaction.money)) {
      // Reversão sem saldo é operacionalmente diferente de aposta sem saldo.
      return reject(
        transaction.isReversal()
          ? FailureCode.ReversalInsufficientFunds
          : FailureCode.InsufficientFunds,
      );
    }

    ledgerEntry = wallet.debit(movement);
  } else {
    ledgerEntry = wallet.credit(movement);
  }

  transaction.markProcessed(reference?.id, now, wallet.balance);

  return { type: 'processed', ledgerEntry, balanceBefore };
}
