import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';

import {
  countRows,
  createTestApp,
  createWallet,
  expectLedgerConsistent,
  TestWallet,
  walletState,
} from '../../test/support/app';
import { IdempotencyConflictError } from '../common/errors/application-errors';

import { FailureCode, WagerTransactionStatus } from './domain/wager-transaction';
import { SubmitWagerCommand, WageringService } from './wagering.service';

/**
 * Integração do use case com PostgreSQL real. A wallet é criada pelo fluxo
 * oficial (saldo inicial → OPENING + CREDIT, version 1); por isso cada
 * movimento soma 1 à version e 1 lançamento ao ledger além da abertura.
 */
describe('WageringService (integration)', () => {
  let app: INestApplication;
  let service: WageringService;
  let wallet: TestWallet;
  let providerId: string;

  const ctx = () => ({ channel: 'http' as const, correlationId: randomUUID() });

  function createCommand(kind: string, amount: string, idempotencyKey: string): SubmitWagerCommand {
    return {
      walletId: wallet.id,
      playerId: wallet.playerId,
      providerId,
      externalTransactionId: `external-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      gameId: 'test-game',
      kind,
      money: { amount, currency: 'BRL' },
      idempotencyKey,
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    service = app.get(WageringService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  beforeEach(async () => {
    providerId = `test-provider-${randomUUID()}`;
    wallet = await createWallet(app, '100.00');
  });

  afterEach(async () => {
    // Invariante final de todos os testes.
    await expectLedgerConsistent(app, wallet.id);
  });

  it('deve debitar a carteira quando uma BET tem saldo suficiente', async () => {
    const result = await service.submit(createCommand('BET', '30.00', 'bet-key-001'), ctx());

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.transaction.observedBalance?.amount).toBe('70.00');
    expect(result.idempotentReplay).toBe(false);
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: '70.00',
      version: 2,
      ledgerEntries: 2,
      debits: 1,
    });
  });

  it('deve rejeitar uma BET sem saldo suficiente', async () => {
    const result = await service.submit(createCommand('BET', '150.00', 'bet-key-002'), ctx());

    expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
      ledgerEntries: 1,
      debits: 0,
    });
  });

  it('deve creditar a carteira quando recebe um WIN', async () => {
    const result = await service.submit(createCommand('WIN', '50.00', 'win-key-001'), ctx());

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: '150.00',
      version: 2,
      ledgerEntries: 2,
      credits: 2,
    });
  });

  it('não deve duplicar o processamento com a mesma chave idempotente', async () => {
    const command = createCommand('WIN', '25.00', 'idempotency-key-001');

    const firstResult = await service.submit(command, ctx());
    const secondResult = await service.submit(command, ctx());

    expect(secondResult.transaction.id).toBe(firstResult.transaction.id);
    expect(secondResult.idempotentReplay).toBe(true);
    // Replay devolve o resultado original, inclusive o saldo observado.
    expect(secondResult.transaction.observedBalance?.amount).toBe('125.00');
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: '125.00',
      version: 2,
      ledgerEntries: 2,
    });
  });

  it('deve gerar conflito quando a mesma chave recebe outro payload', async () => {
    const firstCommand = createCommand('WIN', '25.00', 'idempotency-key-002');
    const secondCommand = { ...firstCommand, money: { amount: '40.00', currency: 'BRL' } };

    await service.submit(firstCommand, ctx());

    await expect(service.submit(secondCommand, ctx())).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: '125.00',
      version: 2,
      ledgerEntries: 2,
    });
  });

  it('deve impedir saldo negativo em duas BETs simultâneas', async () => {
    const [firstResult, secondResult] = await Promise.all([
      service.submit(createCommand('BET', '80.00', 'concurrent-key-001'), ctx()),
      service.submit(createCommand('BET', '80.00', 'concurrent-key-002'), ctx()),
    ]);

    const statuses = [firstResult.transaction.status, secondResult.transaction.status].sort();
    const rejected = [firstResult, secondResult].find(
      (result) => result.transaction.status === WagerTransactionStatus.Rejected,
    );

    expect(statuses).toEqual(
      [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort(),
    );
    expect(rejected?.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: '20.00',
      version: 2,
      ledgerEntries: 2,
      debits: 1,
    });

    expect(
      await countRows(app, `select 1 from "wager_transactions" where "provider_id" = ?`, [
        providerId,
      ]),
    ).toBe(2);
  });
});
