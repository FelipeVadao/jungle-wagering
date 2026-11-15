# Jungle Wagering

Backend para processamento de transações de apostas, desenvolvido com **Bun, NestJS, TypeScript (strict), PostgreSQL, MikroORM e AWS SQS (MiniStack)**, com foco em consistência financeira, idempotência, concorrência entre múltiplas instâncias e processamento assíncrono confiável.

Projeto desenvolvido como solução para o desafio técnico **Backend Developer Jr — Jungle Gaming**. As decisões técnicas, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Objetivo

Processar operações financeiras de apostas garantindo que o sistema **não duplique créditos nem débitos, não perca eventos confirmados e nunca permita saldo negativo**, mesmo com mensagens duplicadas, fora de ordem ou processadas simultaneamente por várias instâncias.

Operações suportadas:

- **BET:** débito do valor da aposta.
- **WIN:** crédito de um prêmio (pode referenciar a BET).
- **LOSS:** registro de aposta perdida, sem movimentação (valor pode ser `0.00`).
- **REFUND:** devolução de uma BET (mesmo valor).
- **ROLLBACK:** reversão de uma BET, WIN ou REFUND (mesmo valor, direção inversa).
- **OPENING:** transação interna gerada pelo saldo inicial da wallet (não pode ser enviada por provedores).

## Tecnologias utilizadas

| Tecnologia | Finalidade |
|---|---|
| Bun 1.x | Runtime, gerenciador de pacotes e test runner (`bun test`) |
| TypeScript (strict) | Linguagem |
| NestJS | Framework backend |
| PostgreSQL 16 | Banco relacional — invariantes também garantidas no schema |
| MikroORM 7 | ORM (Unit of Work, `transactional()`, `LockMode`) e migrations reversíveis |
| AWS SQS (FIFO) | Mensageria (entrada de comandos, DLQ e eventos de integração) |
| MiniStack | Emulação local do SQS |
| Docker Compose | Infraestrutura local |

## Arquitetura (resumo)

Módulos organizados por responsabilidade, com o domínio em classes puras (sem ORM) e mapeamento explícito para as entidades de persistência:

- **Wallets** — criação (com `OPENING` + `CREDIT` na mesma transação SQL), consulta, ledger paginado por cursor e reconciliação.
- **Wagering** — use case único para HTTP e SQS: idempotência persistente, lock da wallet, regras de BET/WIN/LOSS/REFUND/ROLLBACK, `PENDING_REFERENCE` com worker de reprocessamento.
- **Messaging** — consumer SQS com inbox persistente, DLQ explícita, retry com backoff e shutdown gracioso; transactional outbox com publishers concorrentes (`FOR UPDATE SKIP LOCKED`).
- **Observability / Health** — logs JSON estruturados, métricas em `GET /metrics`, liveness e readiness separados.

Garantias principais (detalhes em [ARCHITECTURE.md](ARCHITECTURE.md)):

- dinheiro como `bigint` de centavos no domínio, `numeric(20,2)` no banco e string decimal na API — nunca `number`;
- lock pessimista **por wallet** (`SELECT ... FOR UPDATE`) + advisory lock por `Idempotency-Key`;
- `CHECK` de saldo não negativo, ledger append-only por trigger, transações terminais imutáveis, unicidade de idempotência e de reversão — tudo **no schema**;
- inbox, transação, ledger, saldo e outbox no **mesmo commit**; eventos só são publicados depois do commit.

## Estrutura do projeto

```text
jungle-wagering/
├── scripts/
│   ├── lib/sqs-bootstrap.ts      # criação idempotente das filas FIFO
│   ├── setup-sqs.ts              # bun run sqs:setup
│   ├── migrate.ts                # bun run migration:up | down | status
│   ├── test-sqs.ts               # publica um comando de teste na fila de entrada
│   └── test-outbox.ts            # drena a outbox uma vez (diagnóstico)
├── src/
│   ├── auth/                     # ProviderAuthGuard (ponto de extensão no-op)
│   ├── common/                   # Money, RetryPolicy, erros, filtro HTTP, correlation id
│   ├── health/                   # /health/live e /health/ready
│   ├── messaging/                # consumer, outbox (writer, publisher, relay), SQS, inbox
│   ├── migrations/               # migrations versionadas e reversíveis
│   ├── observability/            # métricas (/metrics)
│   ├── wagering/                 # domínio, use case, worker de PENDING_REFERENCE, API
│   ├── wallets/                  # domínio, ledger, reconciliação, API
│   ├── app.module.ts
│   └── main.ts
├── test/
│   ├── support/                  # app de teste, infraestrutura, instâncias, crash-consumer
│   ├── schema.spec.ts            # migrations e constraints
│   ├── wallets.e2e.spec.ts       # API de wallets
│   ├── wagering.e2e.spec.ts      # API de wagering, reversões, PENDING_REFERENCE, 503
│   ├── concurrency.spec.ts       # paralelismo real
│   └── multi-instance.spec.ts    # processos reais: 3 instâncias, crash e reinício
├── .env.example
├── bunfig.toml                   # preload do ambiente de teste
├── docker-compose.yml
├── mikro-orm.config.ts
├── ARCHITECTURE.md
└── README.md
```

## Pré-requisitos

- Bun 1.x
- Docker Desktop (PostgreSQL e MiniStack)
- AWS CLI (opcional, apenas para inspecionar filas manualmente)

## Configuração do ambiente

### 1. Instalar dependências

```powershell
bun install
```

### 2. Configurar variáveis de ambiente

```powershell
Copy-Item .env.example .env
```

Principais variáveis (todas documentadas no `.env.example`):

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `LOG_FORMAT` | `json` | `json` (estruturado) ou `pretty` |
| `DB_*` | — | Conexão PostgreSQL; `DB_POOL_MAX`, `DB_LOCK_TIMEOUT_MS` |
| `SQS_COMMAND_QUEUE_URL` | `.../wager-transactions.fifo` | Fila de entrada (`WagerTransactionRequested`) |
| `SQS_COMMAND_DLQ_URL` | `.../wager-transactions-dlq.fifo` | DLQ da entrada |
| `SQS_EVENT_QUEUE_URL` | `.../wager-events.fifo` | Eventos de integração publicados pela outbox |
| `SQS_CONSUMER_ENABLED` | `true` | Liga o consumer nesta instância |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Tentativas antes da DLQ |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | Liga o relay da outbox nesta instância |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | Liga o worker de `PENDING_REFERENCE` |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | Tentativas (~5 min no total) antes de `REFERENCE_NOT_FOUND` |

**Importante:** o arquivo `.env` contém configurações locais e não deve ser versionado.

### 3. Subir a infraestrutura

```powershell
docker compose up -d
docker compose ps
```

### 4. Criar as filas SQS

```powershell
bun run sqs:setup
```

Cria (de forma idempotente) as filas FIFO `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ, com redrive policy configurada na entrada) e `wager-events.fifo` (eventos da outbox).

> A DLQ é alimentada **explicitamente** pelo consumer (com `failureReason` nos atributos). A redrive policy do broker usa `maxReceiveCount = SQS_MAX_RECEIVE_COUNT + 2` apenas como rede de segurança.

### 5. Aplicar as migrations

```powershell
bun run migration:up
bun run migration:status
```

Reverter a última: `bun run migration:down`. Criar nova: `bun run migration:create`.

## Executar a aplicação

```powershell
bun run start:dev     # watch + logs legíveis
bun run start         # src/main.ts
bun run build         # nest build → dist/
bun run start:prod    # dist/main.js
```

Para simular várias instâncias, suba processos com portas diferentes (`$env:PORT=3001; bun run start`) apontando para o mesmo banco e as mesmas filas.

## API HTTP

Erros seguem o formato `{ "statusCode", "code", "message", "details?" }`. Toda resposta devolve `X-Correlation-Id` (propagado do request ou gerado).

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria wallet: `{ playerId, initialBalance: { amount, currency } }` → `201` |
| `GET` | `/wallets/:walletId` | Consulta saldo e `version` |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | Ledger do mais recente ao mais antigo, cursor opaco e estável (`limit` 1–200) |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo materializado × ledger (não corrige) |
| `POST` | `/wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta transação |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id externo |
| `GET` | `/health/live` / `/health/ready` | Liveness / readiness (PostgreSQL + SQS) |
| `GET` | `/metrics` | Métricas (formato Prometheus) |

Exemplo:

```powershell
curl -X POST http://localhost:3000/wagering/transactions `
  -H "Content-Type: application/json" `
  -H "Idempotency-Key: provider-a:transaction-123" `
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"<uuid>","walletId":"<uuid>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Status de `POST /wagering/transactions` (um replay devolve o **mesmo** status e corpo, com `idempotentReplay: true`):

| Status | Situação |
|---|---|
| `201` | `PROCESSED` |
| `202` | `PENDING_REFERENCE` (referência ainda não chegou) |
| `422` | `REJECTED` por regra de negócio, com `failureCode` |
| `400` | payload inválido / `Idempotency-Key` ausente |
| `404` | wallet inexistente |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` ou `EXTERNAL_TRANSACTION_ID_CONFLICT` |
| `503` | falha transitória (ex.: lock timeout) — repetir com a mesma chave (`Retry-After`) |

A taxonomia completa de `failureCode` está em [ARCHITECTURE.md](ARCHITECTURE.md#7-failure-codes).

## Processamento por SQS

Mensagem esperada na fila `wager-transactions.fifo` (use `walletId` como `MessageGroupId`):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "<uuid>",
    "walletId": "<uuid>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Para publicar um comando de teste: `bun scripts/test-sqs.ts <walletId> <playerId> [amount]`.

## Testes

Os testes de integração usam **PostgreSQL e MiniStack reais** (suba o `docker compose` antes). O preload `test/support/env.ts` direciona tudo para recursos descartáveis:

- banco `wagering_test`, **recriado a cada execução** (o nome precisa terminar em `_test`; o banco de desenvolvimento nunca é tocado) — isso também executa todas as migrations do zero;
- filas `wager-transactions-test.fifo`, `wager-transactions-test-dlq.fifo` e `wager-events-test.fifo`, esvaziadas no início;
- workers de background desligados (cada teste aciona consumer/worker/publisher explicitamente).

```powershell
bun run test               # tudo
bun run test:unit          # domínio puro (sem infraestrutura)
bun run test:integration   # PostgreSQL + MiniStack + processos reais
bun run test:e2e           # smoke HTTP (health, métricas, correlation id)
bun run test:cov
bun run typecheck
bun run lint
```

Cobertura por requisito do desafio:

| Requisito | Onde |
|---|---|
| `Money`, `Wallet`, regras BET/WIN/LOSS/REFUND/ROLLBACK, moeda, hash de idempotência | `src/**/domain/*.spec.ts` |
| Migrations (up → down → up) e constraints atacadas por SQL direto | `test/schema.spec.ts` |
| Atomicidade wallet/ledger/inbox/outbox, inbox e redelivery, retry e DLQ, `SIGTERM` | `src/messaging/wager-command.consumer.spec.ts` |
| Publishers concorrentes, falha do SQS, crash antes do commit | `src/messaging/outbox.publisher.spec.ts` |
| Mesma aposta 50× em paralelo, cenário 100.00/2×80.00, hot wallet, wallets distintas | `test/concurrency.spec.ts` |
| 3 processos simultâneos, worker morto entre commit e ack, reinício | `test/multi-instance.spec.ts` |
| `REFUND`/`ROLLBACK` antes da referência, expiração, `503` | `test/wagering.e2e.spec.ts` |

Todos verificam a invariante final `wallet.balance == saldo reconstruído pelo ledger`.

## Scripts auxiliares

- `scripts/setup-sqs.ts` — cria as filas (`bun run sqs:setup`).
- `scripts/migrate.ts` — migrations (`bun run migration:up|down|status`).
- `scripts/test-sqs.ts` — publica um `WagerTransactionRequested` de teste.
- `scripts/test-outbox.ts` — publica uma vez os eventos pendentes da outbox e mostra o lag.

## Observações

- O ambiente local usa credenciais fictícias para o MiniStack.
- Autenticação não foi implementada (decisão documentada em [ARCHITECTURE.md](ARCHITECTURE.md#11-authentication)); há um `ProviderAuthGuard` no-op como ponto de extensão. Os endpoints de health ficam abertos.

## Licença

Projeto desenvolvido para fins de avaliação técnica no desafio Backend Developer Jr da Jungle Gaming.
