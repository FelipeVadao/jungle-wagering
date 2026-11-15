import { createHash } from 'node:crypto';

import { Money, MoneyProps } from '../../common/domain/money';

/** Subconjunto de negócio que entra no hash (sem header/metadados de transporte). */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * JSON canônico: chaves de objetos ordenadas recursivamente (ordem de code
 * points), arrays preservam a ordem, campos `undefined` são omitidos.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;

    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        if (source[key] !== undefined) {
          sorted[key] = sortKeys(source[key]);
        }

        return sorted;
      }, {});
  }

  return value;
}

/**
 * payloadHash = hex(SHA-256(canonicalJson(campos de negócio))).
 * O valor monetário é normalizado para escala 2 antes do hash, então
 * "25.5" e "25.50" representam o mesmo payload.
 */
export function computeWagerPayloadHash(fields: WagerPayloadFields): string {
  const money = Money.from(fields.money);

  const businessFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: money.toJSON(),
    referenceExternalTransactionId:
      fields.referenceExternalTransactionId?.trim() || undefined,
  };

  return sha256Hex(canonicalJson(businessFields));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
