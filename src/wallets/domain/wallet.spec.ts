import { CurrencyMismatchError, Money } from '../../common/domain/money';

import {
  InsufficientFundsError,
  InvalidWalletOperationError,
  Wallet,
} from './wallet';
import {
  LedgerDirection,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00.000Z');
let sequence = 0;
const movement = (amount: string) => ({
  entryId: `entry-${++sequence}`,
  transactionId: `tx-${sequence}`,
  money: brl(amount),
  now,
});

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'opening-tx',
    openingEntryId: 'opening-entry',
    now,
  });
}

describe('Wallet', () => {
  it('abre com version 1 e lançamento CREDIT de abertura equivalente ao saldo', () => {
    const { wallet, openingEntry } = openWallet('100.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(openingEntry).not.toBeNull();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('100.00');
    expect(openingEntry?.transactionId).toBe('opening-tx');
  });

  it('abre com saldo zero sem lançamento e ainda com version 1', () => {
    const { wallet, openingEntry } = openWallet('0.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeNull();
  });

  it('credita e debita gerando lançamentos balanceados e incrementando version', () => {
    const { wallet } = openWallet('100.00');

    const credit = wallet.credit(movement('50.00'));
    const debit = wallet.debit(movement('30.00'));

    expect(wallet.balance.amount).toBe('120.00');
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.amount).toBe('100.00');
    expect(credit.balanceAfter.amount).toBe('150.00');
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceAfter.amount).toBe('120.00');
    expect(credit.isBalanced() && debit.isBalanced()).toBe(true);
  });

  it('permite debitar exatamente todo o saldo', () => {
    const { wallet } = openWallet('80.00');

    wallet.debit(movement('80.00'));

    expect(wallet.balance.amount).toBe('0.00');
  });

  it('nunca fica negativa: débito acima do saldo lança e não altera estado', () => {
    const { wallet } = openWallet('10.00');

    expect(() => wallet.debit(movement('10.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  it('rejeita moeda diferente da wallet', () => {
    const { wallet } = openWallet('10.00');

    expect(() =>
      wallet.credit({ ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) }),
    ).toThrow(CurrencyMismatchError);
  });

  it('rejeita movimentos zero ou negativos e não muda version', () => {
    const { wallet } = openWallet('10.00');

    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidWalletOperationError);
    expect(() =>
      wallet.debit({ ...movement('1.00'), money: brl('1.00').negate() }),
    ).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });

  it('rehydrate reconstrói sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('7.00'),
      version: 9,
      createdAt: now,
      updatedAt: now,
    });

    expect(wallet.version).toBe(9);
    expect(wallet.balance.amount).toBe('7.00');
  });
});

describe('WalletLedgerEntry', () => {
  const props = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    createdAt: now,
  };

  it('valida a aritmética na factory', () => {
    expect(WalletLedgerEntry.create(props).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...props, balanceAfter: brl('41.00') })).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  it('não aceita lançamento que produziria saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props,
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(props);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { money: Money }).money = brl('1.00');
    }).toThrow();
  });
});
