import { DomainError } from '../../common/domain/domain-error';
import { Money } from '../../common/domain/money';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry';

import { RetryPolicy } from '../../common/domain/retry-policy';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito pela API/fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** Kinds que provedores podem submeter (HTTP e SQS). */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada. */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

/**
 * Taxonomia de falhas. Estável e legível por máquina; ver ARCHITECTURE.md.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** FAILED: erro não transitório ao reprocessar (auditável). */
  ProcessingError = 'PROCESSING_ERROR',
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode | string;
  processedAt?: Date;
  /** Saldo observado no momento em que a transação atingiu o estado atual. */
  observedBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

/**
 * Transições válidas:
 *
 *   PENDING            → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa agendada)
 *   PROCESSED/REJECTED/FAILED → (terminal: qualquer transição lança InvalidTransactionStateError)
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | string | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new InvalidWagerTransactionError(
        `Kind ${props.kind} cannot be submitted`,
      );
    }

    const reference = props.referenceExternalTransactionId?.trim() || undefined;

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !reference
    ) {
      throw new InvalidWagerTransactionError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    if (props.kind === WagerTransactionKind.Bet && reference) {
      throw new InvalidWagerTransactionError('BET cannot reference another transaction');
    }

    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(
        'A transaction cannot reference itself',
      );
    }

    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('Amount cannot be negative');
    }

    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        `${props.kind} amount must be greater than zero`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Transação interna de abertura: nasce PROCESSED, junto com a wallet. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    now: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('Opening amount must be positive');
    }

    const externalId = `opening:${props.walletId}`;

    return new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      externalId,
      externalId,
      props.payloadHash,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.now,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.now,
      props.money,
      0,
      undefined,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.attempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | string | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    balanceAfter: Money,
  ): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = balanceAfter;
    this._nextAttemptAt = undefined;
  }

  /**
   * Primeira chegada sem referência: PENDING → PENDING_REFERENCE.
   * Reprocessamento sem referência: incrementa `attempts` e agenda a próxima
   * tentativa com backoff exponencial; esgotado o limite, rejeita com
   * REFERENCE_NOT_FOUND. Retorna o status resultante.
   */
  markPendingReference(
    now: Date,
    policy: RetryPolicy,
    observedBalance: Money,
  ): WagerTransactionStatus {
    this.assertNotTerminal('markPendingReference');

    if (this._status === WagerTransactionStatus.Pending) {
      this._status = WagerTransactionStatus.PendingReference;
      this._attempts = 0;
    } else {
      this._attempts += 1;
    }

    this._observedBalance = observedBalance;

    if (this._attempts >= policy.maxAttempts) {
      this.reject(FailureCode.ReferenceNotFound, now, observedBalance);
      return this._status;
    }

    this._nextAttemptAt = policy.nextAttemptAt(now, this._attempts);
    return this._status;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;

    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * REFUND → BET. ROLLBACK → BET, WIN ou REFUND.
   * WIN/LOSS podem (opcionalmente) referenciar a BET da rodada.
   */
  canReference(kind: WagerTransactionKind): boolean {
    switch (this.kind) {
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
        return kind === WagerTransactionKind.Bet;
      case WagerTransactionKind.Rollback:
        return [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ].includes(kind);
      default:
        return false;
    }
  }

  /** null para operações sem efeito no saldo (LOSS). */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return null;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(
            'ROLLBACK direction depends on the reference transaction',
          );
        }

        const original = reference.ledgerDirectionFor();

        if (original === null) {
          throw new InvalidTransactionStateError(
            'Reference transaction has no balance effect to roll back',
          );
        }

        return original === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${transition}: transaction ${this.id} is ${this._status}`,
      );
    }
  }
}
