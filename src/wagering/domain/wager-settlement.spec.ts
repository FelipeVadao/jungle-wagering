import { Money } from '../../common/domain/money';
import { RetryPolicy } from '../../common/domain/retry-policy';
import { Wallet } from '../../wallets/domain/wallet';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry';

import { settleWagerTransaction } from './wager-settlement';
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00.000Z');
const policy = new RetryPolicy(1000, 60_000, 3);
let counter = 0;

function wallet(balance = '100.00'): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function transaction(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  counter += 1;

  return WagerTransaction.create({
    id: `tx-${counter}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${counter}`,
    idempotencyKey: `key-${counter}`,
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    createdAt: now,
    ...overrides,
  });
}

function processed(kind: WagerTransactionKind, amount: string, target = wallet()) {
  const tx = transaction(kind, amount);
  settleWagerTransaction({
    wallet: target,
    transaction: tx,
    reference: null,
    referenceAlreadyReversed: false,
    retryPolicy: policy,
    ledgerEntryId: `entry-${tx.id}`,
    now,
  });
  return tx;
}

function settle(
  target: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | null = null,
  referenceAlreadyReversed = false,
) {
  return settleWagerTransaction({
    wallet: target,
    transaction: tx,
    reference,
    referenceAlreadyReversed,
    retryPolicy: policy,
    ledgerEntryId: `entry-${tx.id}`,
    now,
  });
}

describe('Regras de BET, WIN, LOSS, REFUND e ROLLBACK', () => {
  it('BET debita com 1 entrada DEBIT', () => {
    const target = wallet('100.00');
    const outcome = settle(target, transaction(WagerTransactionKind.Bet, '25.00'));

    expect(outcome.type).toBe('processed');
    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(target.balance.amount).toBe('75.00');
    expect(target.version).toBe(2);
  });

  it('BET sem saldo é REJECTED com INSUFFICIENT_FUNDS, sem ledger e sem alterar saldo', () => {
    const target = wallet('10.00');
    const tx = transaction(WagerTransactionKind.Bet, '10.01');
    const outcome = settle(target, tx);

    expect(outcome).toEqual({ type: 'rejected', failureCode: FailureCode.InsufficientFunds });
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.observedBalance?.amount).toBe('10.00');
    expect(target.balance.amount).toBe('10.00');
    expect(target.version).toBe(1);
  });

  it('WIN credita com 1 entrada CREDIT', () => {
    const target = wallet('100.00');
    const outcome = settle(target, transaction(WagerTransactionKind.Win, '40.00'));

    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(target.balance.amount).toBe('140.00');
  });

  it('LOSS é PROCESSED sem mover saldo e sem lançamento', () => {
    const target = wallet('100.00');
    const tx = transaction(WagerTransactionKind.Loss, '0.00');
    const outcome = settle(target, tx);

    expect(outcome).toEqual({ type: 'processed', ledgerEntry: null, balanceBefore: brl('100.00') });
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.affectsBalance()).toBe(false);
    expect(target.version).toBe(1);
  });

  it('REFUND de uma BET processada credita o mesmo valor', () => {
    const target = wallet('100.00');
    const bet = processed(WagerTransactionKind.Bet, '30.00', target);
    const refund = transaction(WagerTransactionKind.Refund, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const outcome = settle(target, refund, bet);

    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(target.balance.amount).toBe('100.00');
  });

  it('REFUND só referencia BET', () => {
    const target = wallet('100.00');
    const win = processed(WagerTransactionKind.Win, '30.00', target);
    const refund = transaction(WagerTransactionKind.Refund, '30.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });

    expect(settle(target, refund, win)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  it('REFUND/ROLLBACK exigem valor igual ao da referência', () => {
    const target = wallet('100.00');
    const bet = processed(WagerTransactionKind.Bet, '30.00', target);
    const refund = transaction(WagerTransactionKind.Refund, '29.99', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    expect(settle(target, refund, bet)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReversalAmountMismatch,
    });
  });

  it('uma referência não pode ser revertida duas vezes', () => {
    const target = wallet('100.00');
    const bet = processed(WagerTransactionKind.Bet, '30.00', target);
    const rollback = transaction(WagerTransactionKind.Rollback, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    expect(settle(target, rollback, bet, true)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(target.balance.amount).toBe('70.00');
  });

  it('ROLLBACK de BET credita; ROLLBACK de WIN e de REFUND debitam', () => {
    const target = wallet('100.00');
    const bet = processed(WagerTransactionKind.Bet, '10.00', target);
    const win = processed(WagerTransactionKind.Win, '20.00', target);

    const rollbackBet = transaction(WagerTransactionKind.Rollback, '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollbackWin = transaction(WagerTransactionKind.Rollback, '20.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const first = settle(target, rollbackBet, bet);
    const second = settle(target, rollbackWin, win);

    expect(first.type === 'processed' && first.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(second.type === 'processed' && second.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(target.balance.amount).toBe('100.00');

    const bet2 = processed(WagerTransactionKind.Bet, '5.00', target);
    const refund = transaction(WagerTransactionKind.Refund, '5.00', {
      referenceExternalTransactionId: bet2.externalTransactionId,
    });
    settle(target, refund, bet2);
    const rollbackRefund = transaction(WagerTransactionKind.Rollback, '5.00', {
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    const third = settle(target, rollbackRefund, refund);

    expect(third.type === 'processed' && third.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(target.balance.amount).toBe('95.00');
  });

  it('ROLLBACK que deixaria saldo negativo é REJECTED com código distinto de aposta sem saldo', () => {
    const target = wallet('0.00');
    const win = processed(WagerTransactionKind.Win, '50.00', target);
    processed(WagerTransactionKind.Bet, '45.00', target);
    const rollback = transaction(WagerTransactionKind.Rollback, '50.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const outcome = settle(target, rollback, win);

    expect(outcome).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(target.balance.amount).toBe('5.00');
  });

  it('ROLLBACK não referencia LOSS nem ROLLBACK', () => {
    const target = wallet('100.00');
    const loss = processed(WagerTransactionKind.Loss, '0.00', target);
    const rollback = transaction(WagerTransactionKind.Rollback, '1.00', {
      referenceExternalTransactionId: loss.externalTransactionId,
    });

    expect(settle(target, rollback, loss)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  it('referência de outra rodada/wallet/player é REFERENCE_MISMATCH', () => {
    const target = wallet('100.00');
    const bet = processed(WagerTransactionKind.Bet, '10.00', target);
    const refund = transaction(WagerTransactionKind.Refund, '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: 'another-round',
    });

    expect(settle(target, refund, bet)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  it('referência rejeitada é REFERENCE_NOT_PROCESSED', () => {
    const target = wallet('0.00');
    const bet = processed(WagerTransactionKind.Bet, '10.00', target);
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);

    const refund = transaction(WagerTransactionKind.Refund, '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    expect(settle(target, refund, bet)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });

  it('referência ausente → PENDING_REFERENCE; esgotado o limite → REJECTED REFERENCE_NOT_FOUND', () => {
    const target = wallet('100.00');
    const refund = transaction(WagerTransactionKind.Refund, '10.00', {
      referenceExternalTransactionId: 'missing',
    });

    expect(settle(target, refund).type).toBe('pending-reference');
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.attempts).toBe(0);
    expect(refund.nextAttemptAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z');

    expect(settle(target, refund).type).toBe('pending-reference');
    expect(refund.attempts).toBe(1);
    expect(refund.nextAttemptAt?.toISOString()).toBe('2026-01-01T00:00:02.000Z');

    settle(target, refund);
    expect(settle(target, refund)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(target.balance.amount).toBe('100.00');
  });

  it('moeda diferente da wallet é REJECTED CURRENCY_MISMATCH', () => {
    const target = wallet('100.00');
    const bet = transaction(WagerTransactionKind.Bet, '1.00', {
      money: Money.from({ amount: '1.00', currency: 'USD' }),
    });

    expect(settle(target, bet)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.CurrencyMismatch,
    });
  });

  it('wallet de outro player é REJECTED WALLET_PLAYER_MISMATCH', () => {
    const target = wallet('100.00');
    const bet = transaction(WagerTransactionKind.Bet, '1.00', { playerId: 'intruder' });

    expect(settle(target, bet)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.WalletPlayerMismatch,
    });
  });
});

describe('WagerTransaction', () => {
  it('REFUND e ROLLBACK exigem referenceExternalTransactionId', () => {
    expect(() => transaction(WagerTransactionKind.Refund, '1.00')).toThrow(InvalidWagerTransactionError);
    expect(() => transaction(WagerTransactionKind.Rollback, '1.00')).toThrow(InvalidWagerTransactionError);
  });

  it('OPENING é interno e não pode ser submetido', () => {
    expect(() => transaction(WagerTransactionKind.Opening, '1.00')).toThrow(InvalidWagerTransactionError);
  });

  it('BET/WIN/REFUND/ROLLBACK exigem valor positivo; LOSS aceita zero', () => {
    expect(() => transaction(WagerTransactionKind.Bet, '0.00')).toThrow(InvalidWagerTransactionError);
    expect(transaction(WagerTransactionKind.Loss, '0.00').status).toBe(WagerTransactionStatus.Pending);
  });

  it('estados terminais não transicionam (erro de programação)', () => {
    const tx = processed(WagerTransactionKind.Win, '1.00');

    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds, now)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined, now, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingError, now)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(now, policy, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });

  it('matchesPayload compara o hash do payload', () => {
    const tx = transaction(WagerTransactionKind.Bet, '1.00', { payloadHash: 'abc' });

    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });
});
