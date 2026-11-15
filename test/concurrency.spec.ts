import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';

import {
  countRows,
  createTestApp,
  createWallet,
  expectLedgerConsistent,
  submit,
  wager,
  walletState,
} from './support/app';

/**
 * Paralelismo real: N requisições HTTP simultâneas → N transações SQL
 * concorrentes no PostgreSQL (pool com 20 conexões), não chamadas sequenciais.
 */
describe('Concorrência (PostgreSQL real, requisições simultâneas)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await createWallet(app, '100.00');
    const body = wager(wallet, 'BET', '10.00');

    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(app, body)));

    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
    expect(responses.every((response) => response.body.balance.amount === '90.00')).toBe(true);
    expect(
      await countRows(
        app,
        `select 1 from "wager_transactions" where "provider_id" = ? and "external_transaction_id" = ?`,
        [body.providerId, body.externalTransactionId],
      ),
    ).toBe(1);
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: '90.00',
      version: 2,
      debits: 1,
    });
    await expectLedgerConsistent(app, wallet.id);
  });

  it('cenário obrigatório (seção 8): 100.00 e duas BETs de 80.00 simultâneas, repetido 10 vezes', async () => {
    for (let round = 0; round < 10; round += 1) {
      const wallet = await createWallet(app, '100.00');
      const [first, second] = await Promise.all([
        submit(app, wager(wallet, 'BET', '80.00')),
        submit(app, wager(wallet, 'BET', '80.00')),
      ]);

      expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 422]);
      const rejected = first.status === 422 ? first : second;
      expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '20.00',
        version: 2,
        debits: 1,
      });
      await expectLedgerConsistent(app, wallet.id);
    }
  });

  it('hot wallet: créditos e débitos concorrentes nunca deixam o saldo negativo nem perdem atualização', async () => {
    const wallet = await createWallet(app, '50.00');
    const bets = Array.from({ length: 60 }, () => wager(wallet, 'BET', '1.00'));
    const wins = Array.from({ length: 20 }, () => wager(wallet, 'WIN', '1.00'));
    const all = [...bets, ...wins].sort(() => Math.random() - 0.5);

    const responses = await Promise.all(all.map((body) => submit(app, body)));
    const processedBets = responses.filter(
      (response, index) => all[index].kind === 'BET' && response.status === 201,
    ).length;
    const rejectedBets = responses.filter((response) => response.status === 422);

    expect(responses.every((response) => [201, 422].includes(response.status))).toBe(true);
    expect(rejectedBets.every((response) => response.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(
      true,
    );
    expect(processedBets + rejectedBets.length).toBe(60);

    // Sem lost update: saldo = inicial + todos os WINs − BETs processadas.
    const expected = (50 + 20 - processedBets).toFixed(2);
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: expected,
      version: 1 + 20 + processedBets,
      debits: processedBets,
      credits: 1 + 20,
    });
    expect(Number(expected)).toBeGreaterThanOrEqual(0);
    await expectLedgerConsistent(app, wallet.id);
  });

  it('wallets distintas processadas em paralelo, cada uma consistente', async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, () => createWallet(app, '100.00')));

    const responses = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () => submit(app, wager(wallet, 'BET', '10.00'))),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);

    for (const wallet of wallets) {
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '50.00',
        version: 6,
        debits: 5,
      });
      await expectLedgerConsistent(app, wallet.id);
    }
  });

  it('REFUND e ROLLBACK concorrentes da mesma BET: só uma reversão é aplicada', async () => {
    const wallet = await createWallet(app, '100.00');
    const bet = wager(wallet, 'BET', '40.00');
    await submit(app, bet).expect(201);

    const reversals = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        submit(
          app,
          wager(wallet, index % 2 === 0 ? 'REFUND' : 'ROLLBACK', '40.00', {
            referenceExternalTransactionId: bet.externalTransactionId,
            externalTransactionId: `reversal-${randomUUID()}`,
          }),
        ),
      ),
    );

    expect(reversals.filter((response) => response.status === 201)).toHaveLength(1);
    expect(
      reversals
        .filter((response) => response.status !== 201)
        .every((response) => response.body.failureCode === 'REFERENCE_ALREADY_REVERSED'),
    ).toBe(true);
    expect(await walletState(app, wallet.id)).toMatchObject({
      balance: '100.00',
      debits: 1,
      credits: 2,
    });
    await expectLedgerConsistent(app, wallet.id);
  });
});
