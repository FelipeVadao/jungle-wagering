import { InvalidCursorError } from '../common/errors/application-errors';

interface LedgerCursorPayload {
  v: 1;
  /** wallet a que o cursor pertence (impede reuso entre wallets). */
  w: string;
  /** `sequence` do último lançamento entregue (bigint como string). */
  s: string;
}

/**
 * Cursor opaco (base64url de JSON) sobre `ledger_entries.sequence`, uma
 * identity monotônica. Como os lançamentos de uma wallet são inseridos sob o
 * lock dessa wallet, a ordem de `sequence` coincide com a ordem de commit e
 * a paginação keyset é estável mesmo com novas inserções.
 */
export function encodeLedgerCursor(walletId: string, sequence: string): string {
  const payload: LedgerCursorPayload = { v: 1, w: walletId, s: sequence };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string, walletId: string): string {
  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('Malformed cursor');
  }

  const candidate = payload as Partial<LedgerCursorPayload> | null;

  if (
    !candidate ||
    candidate.v !== 1 ||
    candidate.w !== walletId ||
    typeof candidate.s !== 'string' ||
    !/^\d{1,19}$/.test(candidate.s)
  ) {
    throw new InvalidCursorError('Cursor is invalid for this wallet');
  }

  return candidate.s;
}
