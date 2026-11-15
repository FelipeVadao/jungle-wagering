import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { ConflictException } from '@nestjs/common';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../mikro-orm.config';

import { WageringService } from './wagering.service';
import {
  ProcessBetDto,
  WagerOperationType,
} from './dto/process-bet.dto';

import {
  WagerTransaction,
  WagerTransactionStatus,
} from './entities/wager-transaction.entity';

import { Wallet } from '../wallets/entities/wallet.entity';
import { LedgerEntry } from '../wallets/entities/ledger-entry.entity';
import { OutboxEvent } from '../messaging/entities/outbox-event.entity';

describe('WageringService (integration)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: WageringService;

  let wallet: Wallet;
  let providerId: string;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);

    await orm.migrator.up();

    em = orm.em.fork();
    service = new WageringService(em);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  beforeEach(async () => {
    providerId = `test-provider-${randomUUID()}`;

    wallet = em.create(Wallet, {
      id: randomUUID(),
      playerId: randomUUID(),
      currency: 'BRL',
      balance: '100.00',
      version: 0,
    });

    em.persist(wallet);
    await em.flush();
  });

  afterEach(async () => {
    if (!wallet) {
      return;
    }

    const transactions = await em.find(WagerTransaction, {
      providerId,
    });

    const transactionIds = transactions.map(
      (transaction) => transaction.id,
    );

    // Remove eventos da Outbox associados às transações
    // e à carteira, incluindo WalletBalanceChanged.
    await em.nativeDelete(OutboxEvent, {
      $or: [
        { aggregateId: wallet.id },
        { aggregateId: { $in: transactionIds } },
      ],
    });

    await em.nativeDelete(LedgerEntry, {
      wallet: wallet.id,
    });

    await em.nativeDelete(WagerTransaction, {
      providerId,
    });

    await em.nativeDelete(Wallet, {
      id: wallet.id,
    });

    em.clear();
  });

  function createDto(
    kind: WagerOperationType,
    amount: string,
  ): ProcessBetDto {
    return plainToInstance(ProcessBetDto, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      providerId,
      externalTransactionId: `external-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      gameId: 'test-game',
      kind,
      money: {
        amount,
        currency: 'BRL',
      },
    });
  }

  it('deve debitar a carteira quando uma BET tem saldo suficiente', async () => {
    const dto = createDto(WagerOperationType.BET, '30.00');

    const result = await service.processBet(dto, 'bet-key-001');

    em.clear();

    const updatedWallet = await em.findOneOrFail(Wallet, {
      id: wallet.id,
    });

    const ledgerCount = await em.count(LedgerEntry, {
      wallet: wallet.id,
    });

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(updatedWallet.balance).toBe('70.00');
    expect(updatedWallet.version).toBe(1);
    expect(ledgerCount).toBe(1);
  });

  it('deve rejeitar uma BET sem saldo suficiente', async () => {
    const dto = createDto(WagerOperationType.BET, '150.00');

    const result = await service.processBet(dto, 'bet-key-002');

    em.clear();

    const updatedWallet = await em.findOneOrFail(Wallet, {
      id: wallet.id,
    });

    const ledgerCount = await em.count(LedgerEntry, {
      wallet: wallet.id,
    });

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(updatedWallet.balance).toBe('100.00');
    expect(updatedWallet.version).toBe(0);
    expect(ledgerCount).toBe(0);
  });

  it('deve creditar a carteira quando recebe um WIN', async () => {
    const dto = createDto(WagerOperationType.WIN, '50.00');

    const result = await service.processBet(dto, 'win-key-001');

    em.clear();

    const updatedWallet = await em.findOneOrFail(Wallet, {
      id: wallet.id,
    });

    const ledgerCount = await em.count(LedgerEntry, {
      wallet: wallet.id,
    });

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(updatedWallet.balance).toBe('150.00');
    expect(updatedWallet.version).toBe(1);
    expect(ledgerCount).toBe(1);
  });

  it('não deve duplicar o processamento com a mesma chave idempotente', async () => {
    const dto = createDto(WagerOperationType.WIN, '25.00');

    const firstResult = await service.processBet(
      dto,
      'idempotency-key-001',
    );

    const secondResult = await service.processBet(
      dto,
      'idempotency-key-001',
    );

    em.clear();

    const updatedWallet = await em.findOneOrFail(Wallet, {
      id: wallet.id,
    });

    const ledgerCount = await em.count(LedgerEntry, {
      wallet: wallet.id,
    });

    expect(secondResult.transactionId).toBe(
      firstResult.transactionId,
    );

    expect(updatedWallet.balance).toBe('125.00');
    expect(updatedWallet.version).toBe(1);
    expect(ledgerCount).toBe(1);
  });

  it('deve gerar conflito quando a mesma chave recebe outro payload', async () => {
    const firstDto = createDto(WagerOperationType.WIN, '25.00');

    const secondDto = plainToInstance(ProcessBetDto, {
      ...firstDto,
      money: {
        amount: '40.00',
        currency: 'BRL',
      },
    });

    await service.processBet(
      firstDto,
      'idempotency-key-002',
    );

    await expect(
      service.processBet(
        secondDto,
        'idempotency-key-002',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    em.clear();

    const updatedWallet = await em.findOneOrFail(Wallet, {
      id: wallet.id,
    });

    const ledgerCount = await em.count(LedgerEntry, {
      wallet: wallet.id,
    });

    expect(updatedWallet.balance).toBe('125.00');
    expect(updatedWallet.version).toBe(1);
    expect(ledgerCount).toBe(1);
  });

  it('deve impedir saldo negativo em duas BETs simultâneas', async () => {
    const firstDto = createDto(WagerOperationType.BET, '80.00');
    const secondDto = createDto(WagerOperationType.BET, '80.00');

    const [firstResult, secondResult] = await Promise.all([
      service.processBet(firstDto, 'concurrent-key-001'),
      service.processBet(secondDto, 'concurrent-key-002'),
    ]);

    em.clear();

    const updatedWallet = await em.findOneOrFail(Wallet, {
      id: wallet.id,
    });

    const ledgerCount = await em.count(LedgerEntry, {
      wallet: wallet.id,
    });

    const transactionCount = await em.count(WagerTransaction, {
      providerId,
    });

    const statuses = [
      firstResult.status,
      secondResult.status,
    ].sort();

    expect(statuses).toEqual([
      WagerTransactionStatus.PROCESSED,
      WagerTransactionStatus.REJECTED,
    ].sort());

    expect(updatedWallet.balance).toBe('20.00');
    expect(updatedWallet.version).toBe(1);
    expect(ledgerCount).toBe(1);
    expect(transactionCount).toBe(2);
  });
});
