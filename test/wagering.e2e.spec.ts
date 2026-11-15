import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PendingReferenceWorker } from '../src/wagering/pending-reference.worker';

import {
  createTestApp,
  createWallet,
  em,
  expectLedgerConsistent,
  submit,
  TestWallet,
  wager,
  waitFor,
  walletState,
} from './support/app';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Wagering HTTP API (PostgreSQL real)', () => {
  let app: INestApplication;
  let wallet: TestWallet;
  const http = () => request(app.getHttpServer());

  /** Eventos de outbox ligados a uma transação (inclusive WalletBalanceChanged). */
  async function eventsOf(transactionId: string): Promise<string[]> {
    const rows = await em(app).execute<Array<{ event_type: string }>>(
      `select "event_type" from "outbox_events"
        where "aggregate_id" = ?
           or ("event_type" = 'WalletBalanceChanged' and "payload"->'data'->>'transactionId' = ?)
        order by "created_at", "event_type"`,
      [transactionId, transactionId],
    );
    return rows.map((row) => row.event_type).sort();
  }

  beforeAll(async () => {
    app = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  beforeEach(async () => {
    wallet = await createWallet(app, '100.00');
  });

  afterEach(async () => {
    await expectLedgerConsistent(app, wallet.id);
  });

  describe('BET / WIN / LOSS', () => {
    it('BET processada: 201, saldo observado, consultas por id e por (provider, externalId)', async () => {
      const body = wager(wallet, 'BET', '25.00');
      const response = await submit(app, body).expect(201);

      expect(response.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      const byId = await http()
        .get(`/wagering/transactions/${response.body.transactionId}`)
        .expect(200);
      expect(byId.body).toMatchObject({
        transactionId: response.body.transactionId,
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        walletId: wallet.id,
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        status: 'PROCESSED',
        failureCode: null,
        balance: { amount: '75.00', currency: 'BRL' },
      });

      const byExternal = await http()
        .get(
          `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
        )
        .expect(200);
      expect(byExternal.body.transactionId).toBe(response.body.transactionId);

      expect(await eventsOf(response.body.transactionId)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    });

    it('BET sem saldo: 422 INSUFFICIENT_FUNDS, auditável, sem ledger e só evento Rejected', async () => {
      const response = await submit(app, wager(wallet, 'BET', '100.01')).expect(422);

      expect(response.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '100.00', currency: 'BRL' },
      });
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '100.00',
        version: 1,
        ledgerEntries: 1,
      });

      const stored = await http()
        .get(`/wagering/transactions/${response.body.transactionId}`)
        .expect(200);
      expect(stored.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
      expect(await eventsOf(response.body.transactionId)).toEqual(['WagerTransactionRejected']);
    });

    it('WIN credita; LOSS (valor zero) é PROCESSED sem lançamento e sem WalletBalanceChanged', async () => {
      const bet = wager(wallet, 'BET', '10.00');
      await submit(app, bet).expect(201);
      await submit(
        app,
        wager(wallet, 'WIN', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }),
      ).expect(201);
      const loss = await submit(app, wager(wallet, 'LOSS', '0.00')).expect(201);

      expect(loss.body).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '120.00', currency: 'BRL' },
      });
      expect(await eventsOf(loss.body.transactionId)).toEqual(['WagerTransactionProcessed']);
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '120.00',
        version: 3,
        ledgerEntries: 3,
      });
    });
  });

  describe('idempotência', () => {
    it('replay devolve o resultado ORIGINAL (mesmo status, id e saldo observado naquele momento)', async () => {
      const body = wager(wallet, 'BET', '25.00');
      const original = await submit(app, body).expect(201);
      await submit(app, wager(wallet, 'WIN', '10.00')).expect(201);

      const replay = await submit(app, body).expect(201);

      expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
      expect(replay.body.balance.amount).toBe('75.00');
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '85.00',
        ledgerEntries: 3,
      });
    });

    it('replay de uma rejeição devolve o mesmo 422', async () => {
      const body = wager(wallet, 'BET', '500.00');
      const first = await submit(app, body).expect(422);
      const replay = await submit(app, body).expect(422);

      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    it('mesma Idempotency-Key com payload divergente → 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
      const body = wager(wallet, 'BET', '25.00');
      await submit(app, body).expect(201);

      const conflict = await submit(app, { ...body, money: { amount: '26.00', currency: 'BRL' } })
        .expect(409);

      expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(await walletState(app, wallet.id)).toMatchObject({ balance: '75.00', version: 2 });
    });

    it('mesmo externalTransactionId com outra chave → 409 EXTERNAL_TRANSACTION_ID_CONFLICT', async () => {
      const body = wager(wallet, 'BET', '25.00');
      await submit(app, body).expect(201);

      const conflict = await submit(app, body, `another-key-${randomUUID()}`).expect(409);

      expect(conflict.body.code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
      expect(await walletState(app, wallet.id)).toMatchObject({ balance: '75.00', version: 2 });
    });

    it('sem Idempotency-Key → 400 MISSING_IDEMPOTENCY_KEY', async () => {
      const response = await http()
        .post('/wagering/transactions')
        .send(wager(wallet, 'BET', '1.00'))
        .expect(400);

      expect(response.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });
  });

  describe('validação de entrada (400)', () => {
    it.each([
      ['amount number', { money: { amount: 25, currency: 'BRL' } }],
      ['3 casas decimais', { money: { amount: '10.999', currency: 'BRL' } }],
      ['negativo', { money: { amount: '-1.00', currency: 'BRL' } }],
      ['notação científica', { money: { amount: '1e3', currency: 'BRL' } }],
      ['kind OPENING (interno)', { kind: 'OPENING' }],
      ['kind desconhecido', { kind: 'JACKPOT' }],
      ['REFUND sem referência', { kind: 'REFUND' }],
      ['walletId inválido', { walletId: 'not-a-uuid' }],
      ['campo desconhecido', { balance: '1000.00' }],
    ])('%s', async (_case, overrides) => {
      const body = { ...wager(wallet, 'BET', '1.00'), ...overrides };
      const response = await submit(app, body as never).expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(await walletState(app, wallet.id)).toMatchObject({ version: 1 });
    });

    it('BET com valor zero é inválido no domínio (400)', async () => {
      const response = await submit(app, wager(wallet, 'BET', '0.00')).expect(400);
      expect(response.body.code).toBe('INVALID_WAGER_TRANSACTION');
    });

    it('wallet inexistente → 404 WALLET_NOT_FOUND; transação inexistente → 404', async () => {
      const response = await submit(app, wager({ id: randomUUID(), playerId: wallet.playerId }, 'BET', '1.00'))
        .expect(404);
      expect(response.body.code).toBe('WALLET_NOT_FOUND');

      await http().get(`/wagering/transactions/${randomUUID()}`).expect(404);
      await http().get('/wagering/transactions/not-a-uuid').expect(400);
      await http().get(`/providers/provider-test/wagering/transactions/${randomUUID()}`).expect(404);
    });
  });

  describe('regras de negócio rejeitadas (422 com failureCode)', () => {
    it('moeda diferente da wallet → CURRENCY_MISMATCH', async () => {
      const response = await submit(
        app,
        wager(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }),
      ).expect(422);
      expect(response.body.failureCode).toBe('CURRENCY_MISMATCH');
    });

    it('wallet de outro player → WALLET_PLAYER_MISMATCH', async () => {
      const response = await submit(
        app,
        wager(wallet, 'BET', '1.00', { playerId: randomUUID() }),
      ).expect(422);
      expect(response.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    });
  });

  describe('REFUND e ROLLBACK', () => {
    it('REFUND de BET credita o mesmo valor; segunda reversão da mesma referência é rejeitada', async () => {
      const bet = wager(wallet, 'BET', '40.00');
      const betResponse = await submit(app, bet).expect(201);
      const refund = await submit(
        app,
        wager(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }),
      ).expect(201);

      expect(refund.body.balance.amount).toBe('100.00');
      const stored = await http()
        .get(`/wagering/transactions/${refund.body.transactionId}`)
        .expect(200);
      expect(stored.body.referenceTransactionId).toBe(betResponse.body.transactionId);

      for (const kind of ['REFUND', 'ROLLBACK']) {
        const again = await submit(
          app,
          wager(wallet, kind, '40.00', { referenceExternalTransactionId: bet.externalTransactionId }),
        ).expect(422);
        expect(again.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
      }

      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '100.00',
        debits: 1,
        credits: 2,
      });
    });

    it('REFUND só referencia BET; valor deve ser igual; contexto deve coincidir', async () => {
      const bet = wager(wallet, 'BET', '10.00');
      const win = wager(wallet, 'WIN', '5.00');
      await submit(app, bet).expect(201);
      await submit(app, win).expect(201);

      const wrongKind = await submit(
        app,
        wager(wallet, 'REFUND', '5.00', { referenceExternalTransactionId: win.externalTransactionId }),
      ).expect(422);
      const wrongAmount = await submit(
        app,
        wager(wallet, 'REFUND', '9.99', { referenceExternalTransactionId: bet.externalTransactionId }),
      ).expect(422);
      const wrongRound = await submit(
        app,
        wager(wallet, 'REFUND', '10.00', {
          referenceExternalTransactionId: bet.externalTransactionId,
          roundId: 'another-round',
        }),
      ).expect(422);

      expect(wrongKind.body.failureCode).toBe('INVALID_REFERENCE_KIND');
      expect(wrongAmount.body.failureCode).toBe('REVERSAL_AMOUNT_MISMATCH');
      expect(wrongRound.body.failureCode).toBe('REFERENCE_MISMATCH');
      expect(await walletState(app, wallet.id)).toMatchObject({ balance: '95.00' });
    });

    it('ROLLBACK de WIN debita; ROLLBACK de REFUND debita; ROLLBACK de BET credita', async () => {
      const bet = wager(wallet, 'BET', '10.00');
      const win = wager(wallet, 'WIN', '20.00');
      await submit(app, bet).expect(201);
      await submit(app, win).expect(201);

      const rollbackWin = await submit(
        app,
        wager(wallet, 'ROLLBACK', '20.00', { referenceExternalTransactionId: win.externalTransactionId }),
      ).expect(201);
      expect(rollbackWin.body.balance.amount).toBe('90.00');

      const refund = wager(wallet, 'REFUND', '10.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      await submit(app, refund).expect(201);
      const rollbackRefund = await submit(
        app,
        wager(wallet, 'ROLLBACK', '10.00', {
          referenceExternalTransactionId: refund.externalTransactionId,
        }),
      ).expect(201);
      expect(rollbackRefund.body.balance.amount).toBe('90.00');

      const bet2 = wager(wallet, 'BET', '15.00');
      await submit(app, bet2).expect(201);
      const rollbackBet = await submit(
        app,
        wager(wallet, 'ROLLBACK', '15.00', { referenceExternalTransactionId: bet2.externalTransactionId }),
      ).expect(201);
      expect(rollbackBet.body.balance.amount).toBe('90.00');
    });

    it('reversão que deixaria saldo negativo → 422 REVERSAL_INSUFFICIENT_FUNDS (distinto de aposta sem saldo)', async () => {
      const win = wager(wallet, 'WIN', '50.00');
      await submit(app, win).expect(201);
      await submit(app, wager(wallet, 'BET', '140.00')).expect(201);

      const rollback = await submit(
        app,
        wager(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }),
      ).expect(422);

      expect(rollback.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
        balance: { amount: '10.00', currency: 'BRL' },
      });
      expect(await walletState(app, wallet.id)).toMatchObject({ balance: '10.00' });
    });
  });

  describe('referência fora de ordem (PENDING_REFERENCE)', () => {
    const runWorkerUntil = async (transactionId: string, status: string) =>
      waitFor(async () => {
        await app.get(PendingReferenceWorker).runOnce();
        const response = await http().get(`/wagering/transactions/${transactionId}`);
        return response.body.status === status ? response.body : undefined;
      }, 15_000, 20);

    it('REFUND antes da BET: 202 PENDING_REFERENCE e o worker conclui quando a BET chega', async () => {
      const bet = wager(wallet, 'BET', '30.00');
      const refundBody = wager(wallet, 'REFUND', '30.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      });

      const pending = await submit(app, refundBody).expect(202);
      expect(pending.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
      expect(await eventsOf(pending.body.transactionId)).toEqual([
        'WagerTransactionPendingReference',
      ]);

      // Replay enquanto pendente devolve o mesmo 202.
      await submit(app, refundBody).expect(202);

      const betResponse = await submit(app, bet).expect(201);
      expect(betResponse.body.balance.amount).toBe('70.00');

      const resolved = await runWorkerUntil(pending.body.transactionId, 'PROCESSED');

      expect(resolved).toMatchObject({
        status: 'PROCESSED',
        referenceTransactionId: betResponse.body.transactionId,
        balance: { amount: '100.00', currency: 'BRL' },
      });
      expect(await eventsOf(pending.body.transactionId)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '100.00',
        debits: 1,
        credits: 2,
      });

      // Replay depois de resolvida devolve o estado atual (PROCESSED).
      const replay = await submit(app, refundBody).expect(201);
      expect(replay.body.idempotentReplay).toBe(true);
    });

    it('referência que nunca chega: esgotadas as tentativas vira REJECTED REFERENCE_NOT_FOUND com evento', async () => {
      const rollback = await submit(
        app,
        wager(wallet, 'ROLLBACK', '10.00', { referenceExternalTransactionId: `never-${randomUUID()}` }),
      ).expect(202);

      const rejected = await runWorkerUntil(rollback.body.transactionId, 'REJECTED');

      expect(rejected).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
        attempts: 3, // PENDING_REFERENCE_MAX_ATTEMPTS nos testes
      });
      expect(await eventsOf(rollback.body.transactionId)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
      expect(await walletState(app, wallet.id)).toMatchObject({ balance: '100.00', version: 1 });
    });
  });

  it('X-Correlation-Id chega aos eventos da transação', async () => {
    const correlationId = `corr-${randomUUID()}`;
    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .set('X-Correlation-Id', correlationId)
      .send(wager(wallet, 'BET', '1.00'))
      .expect(201);

    expect(response.headers['x-correlation-id']).toBe(correlationId);

    const rows = await em(app).execute<Array<{ correlation_id: string }>>(
      `select "payload"->>'correlationId' as "correlation_id" from "outbox_events"
        where "aggregate_id" = ?`,
      [response.body.transactionId],
    );
    expect(rows).toEqual([{ correlation_id: correlationId }]);
  });
});

describe('Falha transitória no HTTP (lock timeout → 503)', () => {
  let app: INestApplication;
  const previous = process.env.DB_LOCK_TIMEOUT_MS;

  beforeAll(async () => {
    process.env.DB_LOCK_TIMEOUT_MS = '300';
    app = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    process.env.DB_LOCK_TIMEOUT_MS = previous;
    await app?.close();
  }, 60_000);

  it('wallet travada além do lock_timeout → 503 + Retry-After, nada persistido; retry com a mesma chave funciona', async () => {
    const wallet = await createWallet(app, '100.00');
    const body = wager(wallet, 'BET', '10.00');
    const locked = deferred();
    const release = deferred();

    const holder = em(app).transactional(async (tx) => {
      await tx.execute(`select 1 from "wallets" where "id" = ? for update`, [wallet.id]);
      locked.resolve();
      await release.promise;
    });

    try {
      await locked.promise;
      const response = await submit(app, body).expect(503);

      expect(response.headers['retry-after']).toBe('1');
      expect(response.body.code).toBe('TRANSIENT_FAILURE');
    } finally {
      release.resolve();
      await holder;
    }

    expect(await walletState(app, wallet.id)).toMatchObject({ balance: '100.00', version: 1 });

    const retried = await submit(app, body).expect(201);
    expect(retried.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    await expectLedgerConsistent(app, wallet.id);
  });
});
