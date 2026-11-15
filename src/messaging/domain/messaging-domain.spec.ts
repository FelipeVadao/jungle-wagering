import { Money } from '../../common/domain/money';
import { RetryPolicy } from '../../common/domain/retry-policy';
import { Wallet } from '../../wallets/domain/wallet';
import { WalletBalanceChanged } from '../../wallets/domain/wallet-balance-changed.event';

import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';

const now = new Date('2026-01-01T00:00:00.000Z');

function balanceChangedEvent() {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    openingTransactionId: 'tx-1',
    openingEntryId: 'entry-1',
    now,
  });

  return WalletBalanceChanged.from(wallet, openingEntry!, {
    correlationId: 'corr-1',
    causationId: 'msg-1',
    occurredAt: now,
  });
}

describe('IntegrationEvent', () => {
  it('serializa o envelope com eventType/version do tipo e MoneyProps (nunca Money)', () => {
    const json = balanceChangedEvent().toJSON();

    expect(json).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'CREDIT',
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '10.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('OutboxMessage', () => {
  it('nasce pendente e devido; markPublished encerra', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    expect(message.isPending()).toBe(true);
    expect(message.isDue(now)).toBe(true);

    message.markPublished(now);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(now)).toBe(false);
  });

  it('scheduleRetry aplica backoff exponencial com teto', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    const policy = new RetryPolicy(1000, 4000, Number.MAX_SAFE_INTEGER);
    const delays: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      message.scheduleRetry(now, policy, 'boom');
      delays.push((message.nextAttemptAt?.getTime() ?? 0) - now.getTime());
    }

    expect(delays).toEqual([1000, 2000, 4000, 4000]);
    expect(message.attempts).toBe(4);
    expect(message.isDue(now)).toBe(false);
    expect(message.isDue(new Date(now.getTime() + 4000))).toBe(true);
  });
});

describe('InboxMessage', () => {
  it('detecta payload divergente para a mesma messageId', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'consumer',
      payloadHash: 'hash-a',
      receivedAt: now,
    });

    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(now);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.matchesPayload('hash-a')).toBe(true);
    expect(inbox.matchesPayload('hash-b')).toBe(false);
  });
});
