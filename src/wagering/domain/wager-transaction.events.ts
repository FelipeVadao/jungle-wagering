import { MoneyProps } from '../../common/domain/money';
import {
  EventContext,
  eventProps,
  IntegrationEvent,
  IntegrationEventProps,
} from '../../messaging/domain/integration-event';
import { Wallet } from '../../wallets/domain/wallet';

import { WagerTransaction } from './wager-transaction';

interface WagerTransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: MoneyProps;
}

function baseData(transaction: WagerTransaction): WagerTransactionEventBase {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  walletVersion: number;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      eventProps(transaction.id, ctx, {
        ...baseData(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
        processedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  failureCode: string;
  referenceExternalTransactionId: string | null;
  rejectedAt: string;
}

/** Transação rejeitada por regra de negócio (inclui referência expirada). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(
      eventProps(transaction.id, ctx, {
        ...baseData(transaction),
        failureCode: String(transaction.failureCode),
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId ?? null,
        rejectedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string | null;
}

/** Referência ausente: a transação aguarda reprocessamento. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      eventProps(transaction.id, ctx, {
        ...baseData(transaction),
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId ?? '',
        attempts: transaction.attempts,
        nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
      }),
    );
  }
}
