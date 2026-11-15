/**
 * Base de todos os erros de domínio.
 *
 * `code` é estável e legível por máquina: a camada HTTP e o consumer SQS
 * decidem status/ack/DLQ a partir dele, nunca a partir da mensagem.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
