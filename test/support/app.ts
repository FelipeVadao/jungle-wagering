import { randomUUID } from 'node:crypto';

import { ConsoleLogger, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { WalletsService } from '../../src/wallets/wallets.service';

import { ensureTestInfrastructure } from './infra';

export async function createTestApp(): Promise<INestApplication> {
  await ensureTestInfrastructure();

  const logger = new ConsoleLogger({ logLevels: ['error'] });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .setLogger(logger)
    .compile();

  const app = moduleRef.createNestApplication({ logger });
  await app.init();

  return app;
}

export interface TestWallet {
  id: string;
  playerId: string;
}

export async function createWallet(
  app: INestApplication,
  amount = '100.00',
  currency = 'BRL',
): Promise<TestWallet> {
  const playerId = randomUUID();
  const response = await request(app.getHttpServer())
    .post('/wallets')
    .send({ playerId, initialBalance: { amount, currency } })
    .expect(201);

  return { id: response.body.id as string, playerId };
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wager(
  wallet: TestWallet,
  kind: string,
  amount: string,
  overrides: Partial<WagerBody> = {},
): WagerBody {
  return {
    providerId: 'provider-test',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

export function submit(app: INestApplication, body: WagerBody, key?: string) {
  return request(app.getHttpServer())
    .post('/wagering/transactions')
    .set('Idempotency-Key', key ?? `${body.providerId}:${body.externalTransactionId}`)
    .send(body);
}

/** Invariante final: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectLedgerConsistent(
  app: INestApplication,
  walletId: string,
): Promise<{ balance: string; entries: number }> {
  const report = await app.get(WalletsService).reconcile(walletId);

  if (!report.consistent) {
    throw new Error(
      `Wallet ${walletId} inconsistent: stored ${report.storedBalance.amount} vs ledger ${report.calculatedBalance.amount}`,
    );
  }

  return { balance: report.storedBalance.amount, entries: report.checkedEntries };
}

export function em(app: INestApplication): EntityManager {
  return app.get(EntityManager).fork();
}

export interface WalletState {
  balance: string;
  version: number;
  ledgerEntries: number;
  debits: number;
  credits: number;
}

/** Estado persistido da wallet, lido direto do banco (sem identity map). */
export async function walletState(app: INestApplication, walletId: string): Promise<WalletState> {
  const [row] = await em(app).execute<
    Array<{ balance: string; version: number; entries: number; debits: number; credits: number }>
  >(
    `select w."balance"::text as "balance",
            w."version",
            count(l."id")::int as "entries",
            count(l."id") filter (where l."direction" = 'DEBIT')::int as "debits",
            count(l."id") filter (where l."direction" = 'CREDIT')::int as "credits"
       from "wallets" w
       left join "ledger_entries" l on l."wallet_id" = w."id"
      where w."id" = ?
      group by w."id"`,
    [walletId],
  );

  if (!row) {
    throw new Error(`Wallet ${walletId} not found`);
  }

  return {
    balance: row.balance,
    version: row.version,
    ledgerEntries: row.entries,
    debits: row.debits,
    credits: row.credits,
  };
}

export interface TransactionRow {
  id: string;
  status: string;
  failureCode: string | null;
  kind: string;
}

export async function transactionsOf(
  app: INestApplication,
  providerId: string,
  externalTransactionId: string,
): Promise<TransactionRow[]> {
  return em(app).execute<TransactionRow[]>(
    `select "id", "status", "failure_code" as "failureCode", "type" as "kind"
       from "wager_transactions"
      where "provider_id" = ? and "external_transaction_id" = ?`,
    [providerId, externalTransactionId],
  );
}

export async function countRows(
  app: INestApplication,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const [row] = await em(app).execute<Array<{ count: number }>>(
    `select count(*)::int as "count" from (${sql}) as q`,
    params,
  );
  return row?.count ?? 0;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await probe();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
