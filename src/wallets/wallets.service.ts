import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';

import { Wallet } from './entities/wallet.entity';
import { WalletAccount } from './domain/wallet';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { Money } from '../common/domain/money';


@Injectable()
export class WalletsService {
  constructor(
    private readonly em: EntityManager,
  ) {}

async reconcile(walletId: string) {
  const wallet = await this.em.findOne(Wallet, {
    id: walletId,
  });

  if (!wallet) {
    throw new NotFoundException('Wallet not found');
  }

  const entries = await this.em.find(
    LedgerEntry,
    { wallet },
    {
      orderBy: {
        createdAt: 'ASC',
      },
    },
  );

  let ledgerBalance = Money.fromDecimal(
    '0.00',
    wallet.currency,
  );

  for (const entry of entries) {
    const amount = Money.fromDecimal(
      entry.amount,
      wallet.currency,
    );

    if (entry.type === 'BET') {
      ledgerBalance = ledgerBalance.subtract(amount);
    } else if (
      entry.type === 'WIN' ||
      entry.type === 'REFUND'
    ) {
      ledgerBalance = ledgerBalance.add(amount);
    }
  }

  const walletBalance = Money.fromDecimal(
    wallet.balance,
    wallet.currency,
  );

  const difference = walletBalance.subtract(ledgerBalance);

  return {
    walletId: wallet.id,
    currency: wallet.currency,
    walletBalance: walletBalance.toDecimalString(),
    ledgerBalance: ledgerBalance.toDecimalString(),
    difference: difference.toDecimalString(),
    isConsistent: difference.isZero(),
    walletVersion: wallet.version,
    ledgerEntriesCount: entries.length,
  };
}
  
async findLedger(walletId: string) {
  // 1. Verifica se a carteira existe.
  const wallet = await this.em.findOne(Wallet, {
    id: walletId,
  });

  if (!wallet) {
    throw new NotFoundException('Wallet not found');
  }

  // 2. Busca os lançamentos financeiros.
  const entries = await this.em.find(
    LedgerEntry,
    { wallet },
    {
      orderBy: {
        createdAt: 'DESC',
      },
    },
  );

  // 3. Retorna o histórico.
  return entries.map((entry) => ({
    id: entry.id,
    transactionId: entry.transactionId,
    type: entry.type,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    createdAt: entry.createdAt,
  }));
}

  async create(data: { playerId: string; currency: string }) {
    const account = WalletAccount.create(
      data.playerId,
      data.currency,
    );

    const wallet = this.em.create(Wallet, {
      id: randomUUID(),
      playerId: account.playerId,
      currency: account.currency,
      balance: account.balance.toDecimalString(),
      version: account.version,
    });

    try {
      await this.em.persist(wallet).flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictException(
          'Wallet already exists for this player and currency',
        );
      }

      throw error;
    }

    return this.toResponse(wallet);
  }

  async findById(walletId: string) {
    const wallet = await this.em.findOne(Wallet, {
      id: walletId,
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return this.toResponse(wallet);
  }

  private toResponse(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
    };
  }
}
