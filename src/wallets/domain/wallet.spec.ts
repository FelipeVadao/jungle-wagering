import { Money } from '../../common/domain/money';
import { WalletAccount } from './wallet';

describe('WalletAccount', () => {
  it('should create a wallet with zero balance', () => {
    const wallet = WalletAccount.create('player-001', 'BRL');

    expect(wallet.balance.toDecimalString()).toBe('0.00');
    expect(wallet.version).toBe(0);
  });

  it('should credit the wallet', () => {
    const wallet = WalletAccount.create('player-001', 'BRL');

    wallet.credit(Money.fromDecimal('100.00'));

    expect(wallet.balance.toDecimalString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('should debit the wallet', () => {
    const wallet = WalletAccount.create('player-001', 'BRL');

    wallet.credit(Money.fromDecimal('100.00'));
    wallet.debit(Money.fromDecimal('30.00'));

    expect(wallet.balance.toDecimalString()).toBe('70.00');
    expect(wallet.version).toBe(2);
  });

  it('should reject a debit that causes a negative balance', () => {
    const wallet = WalletAccount.create('player-001', 'BRL');

    expect(() => {
      wallet.debit(Money.fromDecimal('10.00'));
    }).toThrow('Insufficient wallet balance');

    expect(wallet.balance.toDecimalString()).toBe('0.00');
    expect(wallet.version).toBe(0);
  });

  it('should reject operations with a different currency', () => {
    const wallet = WalletAccount.create('player-001', 'BRL');

    expect(() => {
      wallet.credit(Money.fromDecimal('10.00', 'USD'));
    }).toThrow('Currency mismatch');
  });

  it('should reject zero and negative amounts', () => {
    const wallet = WalletAccount.create('player-001', 'BRL');

    expect(() => wallet.credit(Money.fromDecimal('0.00'))).toThrow();

    expect(() => wallet.credit(Money.fromDecimal('-10.00'))).toThrow();
  });
});
