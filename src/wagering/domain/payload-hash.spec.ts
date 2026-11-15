import { canonicalJson, computeWagerPayloadHash, WagerPayloadFields } from './payload-hash';

const base: WagerPayloadFields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payloadHash (JSON canônico + SHA-256)', () => {
  it('ordena chaves recursivamente e omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, z: undefined })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
  });

  it('é independente da ordem das chaves e da escala do amount', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25' },
      kind: 'BET',
      gameId: base.gameId,
      roundId: base.roundId,
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: base.externalTransactionId,
      providerId: base.providerId,
    } as WagerPayloadFields;

    expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(base));
    expect(computeWagerPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('idempotency key com payload divergente produz hash diferente', () => {
    const changed = { ...base, money: { amount: '25.01', currency: 'BRL' } };

    expect(computeWagerPayloadHash(changed)).not.toBe(computeWagerPayloadHash(base));
    expect(computeWagerPayloadHash({ ...base, referenceExternalTransactionId: 'x' })).not.toBe(
      computeWagerPayloadHash(base),
    );
  });
});
