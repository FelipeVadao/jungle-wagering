import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import {
  countRows,
  createTestApp,
  createWallet,
  em,
  expectLedgerConsistent,
  submit,
  wager,
} from './support/app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Wallets HTTP API (PostgreSQL real)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it('POST /wallets: saldo inicial gera OPENING + CREDIT na mesma transação e version 1', async () => {
    const playerId = randomUUID();
    const created = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } })
      .expect(201);

    expect(created.body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(created.body.id).toMatch(UUID);

    const fetched = await http().get(`/wallets/${created.body.id}`).expect(200);
    expect(fetched.body).toMatchObject({
      id: created.body.id,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });

    const ledger = await http().get(`/wallets/${created.body.id}/ledger`).expect(200);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({
      kind: 'OPENING',
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
    });

    const opening = await http()
      .get(`/wagering/transactions/${ledger.body.items[0].transactionId}`)
      .expect(200);
    expect(opening.body).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      providerId: 'internal',
      walletId: created.body.id,
      money: { amount: '1000.00', currency: 'BRL' },
    });

    const events = await em(app).execute<Array<{ event_type: string }>>(
      `select "event_type" from "outbox_events"
        where "aggregate_id" in (?, ?) order by "event_type"`,
      [created.body.id, opening.body.transactionId],
    );
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectLedgerConsistent(app, created.body.id);
  });

  it('saldo inicial zero: version 1, sem OPENING e sem lançamento', async () => {
    const wallet = await createWallet(app, '0.00');

    const fetched = await http().get(`/wallets/${wallet.id}`).expect(200);
    expect(fetched.body).toMatchObject({ balance: { amount: '0.00' }, version: 1 });
    expect((await http().get(`/wallets/${wallet.id}/ledger`).expect(200)).body.items).toEqual([]);
    expect(
      await countRows(app, `select 1 from "wager_transactions" where "wallet_id" = ?`, [
        wallet.id,
      ]),
    ).toBe(0);
  });

  it('wallet duplicada para o mesmo playerId + currency → 409; outra moeda é permitida', async () => {
    const playerId = randomUUID();
    const body = { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } };

    await http().post('/wallets').send(body).expect(201);
    const duplicate = await http().post('/wallets').send(body).expect(409);

    expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');
    await http()
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '10.00', currency: 'USD' } })
      .expect(201);
    expect(
      await countRows(app, `select 1 from "wallets" where "player_id" = ?`, [playerId]),
    ).toBe(2);
  });

  it.each([
    ['amount como number', { amount: 10, currency: 'BRL' }],
    ['3 casas decimais', { amount: '10.999', currency: 'BRL' }],
    ['negativo', { amount: '-1.00', currency: 'BRL' }],
    ['notação científica', { amount: '1e3', currency: 'BRL' }],
    ['moeda inválida', { amount: '10.00', currency: 'brl' }],
    ['sem moeda', { amount: '10.00' }],
  ])('POST /wallets rejeita %s com 400', async (_case, initialBalance) => {
    const response = await http()
      .post('/wallets')
      .send({ playerId: randomUUID(), initialBalance })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /wallets rejeita playerId inválido e campos desconhecidos com 400', async () => {
    await http()
      .post('/wallets')
      .send({ playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } })
      .expect(400);
    await http()
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: '1.00', currency: 'BRL' },
        balance: '999.00',
      })
      .expect(400);
  });

  it('GET /wallets/:id → 404 inexistente, 400 id inválido', async () => {
    const missing = await http().get(`/wallets/${randomUUID()}`).expect(404);
    expect(missing.body.code).toBe('WALLET_NOT_FOUND');
    await http().get('/wallets/not-a-uuid').expect(400);
  });

  it('ledger: cursor estável e opaco, sem repetir nem pular itens mesmo com novas escritas', async () => {
    // Regressão: a ordenação precisa ser numérica. Leva a identity para logo
    // antes de uma fronteira de dígitos (ex.: 97 → 98, 99, 100, ...), onde
    // uma ordenação textual ('100' < '99') embaralharia as páginas.
    await em(app).execute(
      `select setval(
                pg_get_serial_sequence('ledger_entries', 'sequence'),
                power(10, length((coalesce(max("sequence"), 0) + 10)::text))::bigint - 3
              )
         from "ledger_entries"`,
    );

    const wallet = await createWallet(app, '100.00');

    for (let index = 1; index <= 7; index += 1) {
      await submit(app, wager(wallet, 'WIN', `${index}.00`)).expect(201);
    }

    const snapshot = await http().get(`/wallets/${wallet.id}/ledger?limit=200`).expect(200);
    const expectedIds = snapshot.body.items.map((item: { id: string }) => item.id);
    expect(expectedIds).toHaveLength(8);

    const page1 = await http().get(`/wallets/${wallet.id}/ledger?limit=3`).expect(200);
    expect(page1.body.items).toHaveLength(3);
    expect(typeof page1.body.nextCursor).toBe('string');

    // Novas escritas entre as páginas não deslocam a paginação.
    await submit(app, wager(wallet, 'WIN', '50.00')).expect(201);
    await submit(app, wager(wallet, 'BET', '10.00')).expect(201);

    const page2 = await http()
      .get(`/wallets/${wallet.id}/ledger`)
      .query({ limit: 3, cursor: page1.body.nextCursor })
      .expect(200);
    const page3 = await http()
      .get(`/wallets/${wallet.id}/ledger`)
      .query({ limit: 3, cursor: page2.body.nextCursor })
      .expect(200);

    expect(page3.body.items).toHaveLength(2);
    expect(page3.body.nextCursor).toBeNull();

    const paged = [...page1.body.items, ...page2.body.items, ...page3.body.items].map(
      (item: { id: string }) => item.id,
    );
    expect(paged).toEqual(expectedIds);
    // Ordem: mais recente primeiro; o último é a abertura.
    expect(page3.body.items[1].kind).toBe('OPENING');
    await expectLedgerConsistent(app, wallet.id);
  });

  it('ledger: cursor inválido, de outra wallet ou limit fora da faixa → 400', async () => {
    const first = await createWallet(app, '10.00');
    const second = await createWallet(app, '10.00');
    await submit(app, wager(first, 'WIN', '1.00')).expect(201);

    const page = await http().get(`/wallets/${first.id}/ledger?limit=1`).expect(200);
    expect(page.body.nextCursor).toEqual(expect.any(String));

    const foreign = await http()
      .get(`/wallets/${second.id}/ledger`)
      .query({ cursor: page.body.nextCursor })
      .expect(400);
    expect(foreign.body.code).toBe('INVALID_CURSOR');

    const garbage = await http()
      .get(`/wallets/${first.id}/ledger`)
      .query({ cursor: 'not-a-cursor' })
      .expect(400);
    expect(garbage.body.code).toBe('INVALID_CURSOR');

    await http().get(`/wallets/${first.id}/ledger?limit=0`).expect(400);
    await http().get(`/wallets/${first.id}/ledger?limit=201`).expect(400);
    await http().get(`/wallets/${randomUUID()}/ledger`).expect(404);
  });

  it('reconciliação: consistente; divergência é sinalizada e NÃO corrigida silenciosamente', async () => {
    const wallet = await createWallet(app, '100.00');
    await submit(app, wager(wallet, 'BET', '30.00')).expect(201);

    const ok = await http().post(`/wallets/${wallet.id}/reconciliation`).expect(200);
    expect(ok.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '70.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });

    // Corrompe o saldo materializado por fora da aplicação.
    await em(app).execute(`update "wallets" set "balance" = "balance" + 5 where "id" = ?`, [
      wallet.id,
    ]);

    try {
      const broken = await http().post(`/wallets/${wallet.id}/reconciliation`).expect(200);
      expect(broken.body).toMatchObject({
        consistent: false,
        storedBalance: { amount: '75.00' },
        calculatedBalance: { amount: '70.00' },
        difference: { amount: '5.00' },
      });

      // Nada foi "consertado" automaticamente.
      const fetched = await http().get(`/wallets/${wallet.id}`).expect(200);
      expect(fetched.body.balance.amount).toBe('75.00');

      const metrics = await http().get('/metrics').expect(200);
      expect(metrics.text).toMatch(/reconciliation_mismatches_total(\{[^}]*\})? [1-9]/);
    } finally {
      await em(app).execute(`update "wallets" set "balance" = "balance" - 5 where "id" = ?`, [
        wallet.id,
      ]);
    }

    await expectLedgerConsistent(app, wallet.id);
  });
});
