export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

/**
 * Registro persistente de deduplicação por (consumerName, messageId).
 * Gravado na mesma transação SQL do efeito financeiro: se a transação faz
 * rollback, a mensagem volta a ser elegível; se confirma, redeliveries são
 * reconhecidos como duplicatas.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId.trim() || !props.consumerName.trim()) {
      throw new Error('messageId and consumerName are required');
    }

    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    this._processedAt ??= at;
  }

  /** Mesma messageId com payload diferente é conflito, não duplicata. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
