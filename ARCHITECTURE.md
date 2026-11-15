# Architecture

## 1. Overview

The Distributed Wagering Processor receives wagering operations from game providers (HTTP or SQS), applies them to player wallets and publishes integration events. Delivery is at-least-once, so the same operation can arrive many times, out of order, or concurrently on several instances. The system must never duplicate credits or debits, lose confirmed events, or allow a negative balance.

Stack: Bun 1.x (runtime and test runner), TypeScript strict, NestJS, PostgreSQL 16, MikroORM 7, AWS SQS FIFO (MiniStack locally), Docker Compose.

## 2. Main Components

| Module | Responsibility |
|---|---|
| `wallets` | Wallet creation (with `OPENING`), queries, cursor-paginated ledger, reconciliation |
| `wagering` | The single wager use case (shared by HTTP and SQS), the `PENDING_REFERENCE` worker, transaction queries |
| `messaging` | SQS adapter, command consumer with an inbox, transactional outbox (writer, publisher, relay) |
| `observability` / `health` | Metrics (`GET /metrics`), liveness and readiness |
| `auth` | `ProviderAuthGuard`, an explicit no-op extension point (section 11) |

Layering:

- **Domain classes** are pure TypeScript with no ORM or Nest imports. They use private constructors and `create`/`from`/`rehydrate` factories, and every invariant lives inside them: `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `settleWagerTransaction`, `IntegrationEvent` and its subclasses, `OutboxMessage`, `InboxMessage`, `RetryPolicy`.
- **Persistence entities** (`*Entity`) are plain MikroORM mappings, kept separate from the domain classes. Explicit mappers (`*.persistence.ts`, `outbox.writer.ts`) translate between the two, so the domain never depends on the ORM.
- **Application services** (`WalletsService`, `WageringService`) own the transaction boundaries and the locks.
- **Adapters**: controllers, the SQS consumer, workers and the `SqsService`.

## 3. ORM, Money Mapping and Transaction Strategy

### MikroORM

MikroORM is the preferred option in the challenge. It provides an explicit Unit of Work, `em.fork().transactional()` and `LockMode.PESSIMISTIC_WRITE`.

- Every use case runs inside **one** `transactional()` block on a forked `EntityManager`. The fork means no state is shared between requests.
- Reads that decide money movements (idempotency lookups, references, re-reads in the worker) use `disableIdentityMap: true`, so they always see the database and never a cached entity.
- A few hot paths use raw SQL where it is clearer than the query builder: the advisory lock, outbox claiming with `SKIP LOCKED`, the inbox `ON CONFLICT`, ledger keyset pagination and reconciliation.

### Money

- **Domain:** `Money` holds a `bigint` of minor units plus an ISO-4217 currency code. Arithmetic is exact. Mixing currencies throws `CurrencyMismatchError`.
- **Input (API and SQS):** the amount must be a decimal string matching `^(0|[1-9]\d{0,17})(\.\d{1,2})?$`.
  - Numbers, exponents, signs, leading zeros, more than two decimals, `NaN` and `Infinity` are rejected.
  - Nothing is rounded silently: `10.999` is rejected rather than rounded.
  - Input is normalized to scale 2, so `25.5` becomes `25.50`.
- **Database:** `numeric(20,2)`. MikroORM maps it as a `string`, so values never pass through JavaScript `number`.
- **Output and events:** `MoneyProps` (`{ amount: "25.50", currency: "BRL" }`), never a `Money` instance.

### Transaction boundaries

These rows are written in the **same** SQL transaction:

- the inbox row (SQS only);
- the wager transaction;
- the ledger entry;
- the wallet balance and `version`;
- the outbox events.

Either all of them commit or none do. Events reach SQS only after the commit, through the outbox (section 9.3).

## 4. Financial Consistency and Schema Guarantees

- The **ledger** (`ledger_entries`) is the audit trail. Each entry carries `direction`, `amount`, `balance_before` and `balance_after`, plus a monotonic `sequence` identity used for ordering and pagination.
  - A transaction has at most one ledger entry.
  - `REJECTED` transactions and `LOSS` produce no entry.
- `wallets.balance` is a materialized value. It is updated together with the entry, under the wallet row lock. `version` increments on every balance change and starts at 1.
- **Opening a wallet:** an initial balance greater than zero creates, in the same SQL transaction, an internal `OPENING` transaction (`providerId = internal`, status `PROCESSED`) and its `CREDIT` entry. It also emits `WagerTransactionProcessed` and `WalletBalanceChanged`.
- **Reconciliation** (`POST /wallets/:id/reconciliation`) compares the stored balance with the balance rebuilt from the ledger, in a single SQL statement. A divergence is reported, logged at error level and counted in `reconciliation_mismatches_total`. It is **never corrected silently**.

Rules enforced by the **database itself** (migration `Migration20261115200000`), so they hold even if application code is bypassed:

| Guarantee | Mechanism |
|---|---|
| Balance never negative | `CHECK (balance >= 0)` on wallets; `CHECK` on ledger balances and on `balance_after` |
| One wallet per player and currency | `UNIQUE (player_id, currency)` |
| Ledger append-only | Trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` |
| Ledger arithmetic | `CHECK`: credit means `after = before + amount`, debit means `after = before - amount`; `amount > 0` |
| One ledger entry per transaction | `UNIQUE (transaction_id)`, FK to `wager_transactions` (deferrable) |
| Persistent idempotency | `UNIQUE (provider_id, idempotency_key)` and `UNIQUE (provider_id, external_transaction_id)` |
| A reference is reversed at most once | Partial unique index on `reference_transaction_id` where type is `REFUND`/`ROLLBACK` and status is `PROCESSED` |
| Terminal transactions are immutable | Trigger rejects `UPDATE` when the old status is `PROCESSED`, `REJECTED` or `FAILED` |
| `REFUND`/`ROLLBACK` need a reference; amounts valid | `CHECK` constraints on `wager_transactions` |
| Inbox deduplication | `UNIQUE (consumer_name, message_id)` |
| Outbox state is coherent | `CHECK`: `PUBLISHED` if and only if `published_at` is not null |

`test/schema.spec.ts` attacks each of these guarantees with raw SQL.

## 5. Concurrency Control

**The unit of concurrency is the `walletId`.** The strategy is pessimistic locking, which the challenge allows.

Every use case takes its locks in this fixed order, so lock cycles cannot occur:

1. `pg_advisory_xact_lock(hashtextextended('idempotency:{providerId}:{key}', 0))`. This serializes concurrent duplicates of the same operation, so the second one sees the first one's committed result and returns it as a replay. The lock is scoped to one key, not global.
2. `SELECT ... FOR UPDATE` on the wallet row. This serializes every balance change on that wallet. Different wallets proceed in parallel.

Inside the lock the service:

- re-reads the wallet and the reference;
- decides the outcome in the domain;
- writes the balance, `version`, ledger entry, transaction and outbox events;
- commits.

There is no read → calculate → update without a lock. The database `CHECK` constraints are the last line of defense.

`SET LOCAL lock_timeout` (`DB_LOCK_TIMEOUT_MS`) bounds the wait. On timeout or deadlock the request is answered with `503 TRANSIENT_FAILURE` and `Retry-After`, nothing is persisted, and the client retries with the same `Idempotency-Key`.

**Why pessimistic locking:** wagering traffic concentrates on hot wallets, where optimistic retries would waste work and add tail latency. A row lock makes the outcome of competing bets deterministic: one bet wins and the other is rejected with `INSUFFICIENT_FUNDS`.

**Multiple instances:** every guarantee lives in PostgreSQL (row locks, advisory locks, unique constraints, `SKIP LOCKED`), never in process memory, so any number of instances is correct. `test/multi-instance.spec.ts` runs three real OS processes.

SQS FIFO ordering and deduplication are only an optimization. The database remains the guarantee.

## 6. Idempotency

- **Key:** `(providerId, Idempotency-Key)`. On HTTP the key comes from the header; on SQS it is `data.idempotencyKey`. It is stored in the database, never in memory.
- **`payloadHash`:** `SHA-256(canonicalJSON(fields))` over these business fields:
  - `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`;
  - `money`, normalized to scale 2;
  - `referenceExternalTransactionId`, trimmed and omitted when empty.

  Canonical JSON sorts object keys recursively and omits `undefined`. Transport metadata (headers, `messageId`) is excluded.
- **Same key and same hash:** the original result is returned with the same HTTP status, the same `transactionId` and the **balance observed at the time**, stored in `balance_after`, plus `idempotentReplay: true`.
- **Same key and different hash:** `409 IDEMPOTENCY_KEY_CONFLICT`. Nothing changes.
- **Same `externalTransactionId` under another key:** `409 EXTERNAL_TRANSACTION_ID_CONFLICT`. `(providerId, externalTransactionId)` identifies the provider operation.
- **SQS adds an inbox:** `(consumerName, messageId)` is inserted with `ON CONFLICT DO NOTHING` in the same transaction as the use case.
  - The same `messageId` with a different payload hash is a permanent conflict (`INBOX_PAYLOAD_CONFLICT`, sent to the DLQ).
  - Different `messageId`s carrying the same idempotency key are replays of the use case.

## 7. Failure Codes

### Business rejections

Business rejections are persisted as `REJECTED` and remain auditable (`GET /wagering/transactions/:id`). HTTP answers `422`; SQS acknowledges the message.

| `failureCode` | Meaning | Provider action |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` above the available balance | Do not resend the same operation; it is final |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` of a credit (`WIN`/`REFUND`) would make the balance negative | Operational follow-up, distinct from a bet without balance |
| `CURRENCY_MISMATCH` | Currency differs from the wallet currency | Fix the payload |
| `WALLET_PLAYER_MISMATCH` | The wallet belongs to another player | Fix the payload |
| `INVALID_REFERENCE_KIND` | The reference has the wrong kind (`REFUND` needs a `BET`; `ROLLBACK` needs a `BET`, `WIN` or `REFUND`; `WIN`/`LOSS` may only reference a `BET`) | Fix the payload |
| `REFERENCE_MISMATCH` | The reference has a different provider, player, wallet, currency or round | Fix the payload |
| `REFERENCE_NOT_PROCESSED` | The reference exists but was rejected or failed | Final |
| `REVERSAL_AMOUNT_MISMATCH` | The `REFUND`/`ROLLBACK` amount differs from the reference amount | Fix the payload; partial reversal is out of scope |
| `REFERENCE_ALREADY_REVERSED` | The reference was already reversed | Final |
| `REFERENCE_NOT_FOUND` | The reference never arrived before retries ran out (section 8.4) | Resend after the reference exists, using a new `externalTransactionId` |

`FAILED` / `PROCESSING_ERROR` (`500`) means the `PENDING_REFERENCE` worker hit an unexpected, non-transient error. It is persisted for audit.

### Request errors

Request errors are not persisted. Body: `{ statusCode, code, message, details? }`.

| Status | `code` |
|---|---|
| `400` | `VALIDATION_ERROR`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_WAGER_TRANSACTION` (for example `BET` with `0.00`), `INVALID_MONEY`, `INVALID_CURSOR` |
| `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| `409` | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| `503` | `TRANSIENT_FAILURE`, with `Retry-After: 1` (lock timeout, deadlock, connection failure) |
| `500` | `INTERNAL_ERROR`; internal details are not exposed |

### Transaction status codes

| Status | HTTP |
|---|---|
| `PROCESSED` | `201` |
| `PENDING_REFERENCE` | `202` |
| `REJECTED` | `422` |
| `FAILED` | `500` |

Because the HTTP status derives from the stored state, a replay returns the same code.

## 8. Transaction Lifecycle and Business Rules

### 8.1 States

```
PENDING ──► PROCESSED | REJECTED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | PENDING_REFERENCE (attempts+1) | FAILED
```

- `PENDING` exists only in memory: the outcome is decided before the commit.
- `PROCESSED`, `REJECTED` and `FAILED` are terminal. The domain throws `InvalidTransactionStateError` on any further transition, and a database trigger blocks the update.

### 8.2 Rules and the interpretations adopted

- **`BET`** debits and cannot carry a reference.
- **`WIN`** credits. **`LOSS`** is `PROCESSED` with no ledger entry and no `WalletBalanceChanged`.
  - Both may optionally reference a `BET`. When the reference is present it is validated like any other reference, and a missing reference leads to `PENDING_REFERENCE`.
  - `LOSS` accepts `0.00`. Every other kind requires an amount greater than zero.
- **`REFUND`** credits back a `BET` for the same amount.
- **`ROLLBACK`** applies the inverse direction of its reference:
  - `BET` (debit) → credit;
  - `WIN` or `REFUND` (credit) → debit.
- **Reversal uniqueness (interpretation).** The challenge says a reference cannot be reversed twice *by the same type of operation*. We apply a stricter rule: **a reference can be reversed at most once by any `REFUND` or `ROLLBACK`**. A `REFUND` followed by a `ROLLBACK` of the same `BET` would credit the stake twice, which violates the "no duplicated credit" invariant. Reversing the reversal is still allowed, because a `ROLLBACK` of a `REFUND` references the `REFUND`, not the `BET`. The rule is enforced in the domain, under the wallet lock, and by the partial unique index.
- **Reversals and negative balances.** A reversal that would leave the balance negative is rejected with `REVERSAL_INSUFFICIENT_FUNDS`, which is distinct from `INSUFFICIENT_FUNDS`.
- **References** are resolved by `(providerId, referenceExternalTransactionId)` and must match provider, player, wallet, currency and round.
- **`OPENING`** is internal only. Providers cannot submit it (`400`).

### 8.3 Integration events

| Event | When | `aggregateId` |
|---|---|---|
| `WagerTransactionProcessed` | Any applied transaction, including `LOSS` and `OPENING` | `transactionId` |
| `WagerTransactionRejected` | Business rejection, including `REFERENCE_NOT_FOUND` | `transactionId` |
| `WalletBalanceChanged` | Only when the balance changes; carries `walletVersion` | `walletId` |
| `WagerTransactionPendingReference` | First time a reference is missing (re-schedules do not emit it again) | `transactionId` |

`IntegrationEvent<T>` is an abstract class. `eventType` and `version` live in each subclass. `toJSON()` produces a stable envelope with an ISO `occurredAt` and `MoneyProps` data.

`correlationId` comes from:

- HTTP: `X-Correlation-Id`, propagated or generated;
- SQS: the envelope `correlationId`, or the `messageId`;
- the `PENDING_REFERENCE` worker: the transaction id.

`causationId` is the request correlation id or the SQS `messageId`.

### 8.4 Out-of-order references (`PENDING_REFERENCE`)

A transaction whose reference is missing, or still pending, is stored as `PENDING_REFERENCE` with `next_attempt_at`. The scheduled worker (`PendingReferenceWorker`, one per instance):

1. selects due rows;
2. for each row, locks the wallet and **re-reads the row under the lock**, so another instance may already have resolved it;
3. settles it again;
4. emits `Processed` or `Rejected`, or re-schedules it.

The retry policy uses exponential backoff, configured by environment:

| Setting | Default |
|---|---|
| Base delay | 1 s |
| Multiplier | ×2 per attempt |
| Maximum delay | 60 s |
| Maximum attempts | 10 |

Total wait is about 1 + 2 + 4 + 8 + 16 + 32 + 60 × 4 ≈ **5 minutes**. After that the transaction becomes `REJECTED` / `REFERENCE_NOT_FOUND` and `WagerTransactionRejected` is published.

Why 5 minutes: out-of-order arrival comes from redelivery and concurrent consumers, which take seconds. The worst redelivery window of the input queue is visibility 30 s × 5 receives, about 2.5 minutes, so 5 minutes covers it with margin. Waiting longer would leave the provider without a final answer, and a provider that still needs the operation can resend it once the reference exists.

## 9. Messaging Reliability

### 9.1 Queues

| Queue | Purpose |
|---|---|
| `wager-transactions.fifo` | Input (`WagerTransactionRequested`), `MessageGroupId = walletId` |
| `wager-transactions-dlq.fifo` | DLQ for the input queue |
| `wager-events.fifo` | Outbox events, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId` |

`bun run sqs:setup` creates them. The broker redrive policy uses `maxReceiveCount = SQS_MAX_RECEIVE_COUNT + 2`, so it is only a safety net. The application moves messages to the DLQ explicitly, with a reason.

### 9.2 Consumer (`WagerCommandConsumer`)

- Validates the envelope and `data` with the same rules as HTTP, then calls **the same use case** (`submitInTransaction`) inside the transaction that inserts the inbox row.
- Acknowledges (`DeleteMessage`) **only after the commit**. If the ack fails, the redelivery hits the inbox as a duplicate and is acknowledged with no financial effect. This scenario is tested with a real killed process.
- Classifies outcomes:

| Outcome | Handling |
|---|---|
| Business outcome persisted (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`) or inbox duplicate | Ack |
| Permanent: any `DomainError` (invalid message, conflicts, unknown wallet) or a unique-constraint violation | Explicit DLQ with `failureReason`, `failureDetail`, `originalMessageId` and `receiveCount` attributes, then ack |
| Transient: anything else (connection, lock timeout, deadlock, unknown) | `ChangeMessageVisibility` with backoff `min(base × 2^(n-1), 900 s)` |
| `ApproximateReceiveCount >= SQS_MAX_RECEIVE_COUNT` | DLQ with `MAX_RECEIVE_COUNT_EXCEEDED` |

  A transient failure rolls back everything, including the inbox row, so the redelivery is processed normally.
- **SIGTERM:** `enableShutdownHooks()` calls `consumer.stop()`, which:
  1. stops polling and aborts the long poll;
  2. lets the in-flight message finish (commit and ack);
  3. returns the rest of the batch with visibility 0.

  The outbox relay and the pending-reference worker finish their current tick before stopping.

### 9.3 Transactional outbox

- **Writer.** `enqueueIntegrationEvent(tx, event)` persists the envelope in `outbox_events` within the business transaction. No event exists unless the financial change committed.
- **Publisher and relay.** `OutboxRelay` runs a polling loop on every instance. Each tick, `OutboxPublisher.publishPending()` runs inside a transaction:
  1. `SELECT ... FOR UPDATE SKIP LOCKED` claims due `PENDING` rows in `(created_at, id)` order.
  2. It publishes them to SQS **while holding the row locks**, so concurrent publishers skip those rows and never publish the same event at the same time.
  3. Each row is marked `PUBLISHED` or rescheduled.
  4. The transaction commits.
- **Failures.** When SQS fails, `attempts + 1` and `next_attempt_at` moves forward with exponential backoff (1 s up to 5 min). `last_error` is kept and the event is never dropped. A failed or backing-off event blocks the later events of the **same aggregate**, within the batch and across batches, so they do not overtake it.
- **Crash scenarios.**
  - *Commit, then the process dies before publishing:* the row stays `PENDING` and any other instance publishes it.
  - *Publish, then the process dies before commit:* the claim rolls back and the event is published again with **the same `eventId`**. This is at-least-once delivery; consumers deduplicate by `eventId`, which is also the FIFO deduplication id.
- **Metrics.** `outbox_pending_events` and `outbox_lag_seconds` (the age of the oldest pending event) are refreshed every tick.

## 10. Observability

- **Logs.** JSON through Nest's `ConsoleLogger` (`LOG_FORMAT=pretty` for development). Log lines carry `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `status` and `failureCode`. Monetary values and full payloads are **not** logged.
- **Metrics.** Prometheus text format at `GET /metrics`, kept in process (per instance):

| Area | Metrics |
|---|---|
| Transactions | `wager_transactions_total{status,kind,channel}` |
| Idempotency | `idempotency_duplicates_total`, `idempotency_conflicts_total` |
| SQS | `sqs_message_retries_total`, `sqs_messages_dead_lettered_total` |
| Wallet locks | `wallet_lock_conflicts_total`, `wallet_lock_wait_seconds` (histogram) |
| Latency | `wager_processing_duration_seconds` (histogram) |
| Outbox | `outbox_lag_seconds`, `outbox_pending_events`, `outbox_published_total`, `outbox_publish_failures_total` |
| Pending references | `pending_reference_retries_total` |
| Reconciliation | `reconciliation_runs_total`, `reconciliation_mismatches_total` |

- **Health.** `GET /health/live` is process liveness. `GET /health/ready` checks PostgreSQL (`select 1`) and SQS (`GetQueueAttributes`) with timeouts, and returns `503` if either is down.

## 11. Authentication

Authentication is **not implemented**. It earns no points in the challenge and would compete with financial correctness, concurrency and idempotency.

The extension point is explicit: `ProviderAuthGuard`, a no-op guard on the wallet and wagering controllers. Health endpoints stay open.

Intended design:

1. Keycloak (or Zitadel) runs in Docker Compose.
2. Each provider is a confidential client using the OAuth2 *client credentials* flow.
3. The guard validates the JWT (issuer, audience, expiry and signature via JWKS) and reads a `provider_id` claim.
4. The request is rejected (`403`) when `body.providerId`, or the `:providerId` path parameter, differs from the claim.

SQS is treated as a trusted internal channel, but the `providerId` inside each message still goes through the same domain validation.

## 12. Testing

All integration tests use **real PostgreSQL and MiniStack**. The preload in `bunfig.toml` points them at disposable resources:

- the `wagering_test` database, recreated from scratch, which also runs every migration;
- `*-test.fifo` queues, purged at the start.

Background workers are disabled during tests, so each test drives the consumer, publisher or worker explicitly and deterministically. Fault injection (a failing ack, a transient error after the writes, an SQS outage, a crash before commit) wraps the real collaborators. It never replaces PostgreSQL or SQS.

| Layer | Files |
|---|---|
| Unit (domain) | `money`, `wallet`, `wager-settlement`, `payload-hash`, `messaging-domain` specs |
| Integration | `schema`, `wallets.e2e`, `wagering.e2e`, `outbox.publisher`, `wager-command.consumer`, `wagering.service` specs |
| Concurrency (real parallelism) | `concurrency.spec.ts`: 50 identical bets, the 100.00 / 2 × 80.00 scenario repeated, hot wallet, distinct wallets, competing reversals |
| Processes | `multi-instance.spec.ts`: 3 `bun src/main.ts` processes at once; a consumer process killed after commit and before ack; an instance killed mid-traffic and restarted with idempotent retries |

Every test ends by checking `wallet.balance == balance rebuilt from the ledger`.

## 13. Trade-offs and Limitations

- **Authentication** is not implemented (section 11).
- **Event ordering across concurrent publishers is best-effort.** Inside a publisher the order is `(created_at, id)`, and an event in backoff blocks later events of the same aggregate. Two publishers can still interleave events of one aggregate when a batch boundary splits them. Consumers must deduplicate by `eventId` and can order wallet events by `walletVersion`.
- **Head-of-line blocking.** An event that keeps failing to publish holds back the later events of its aggregate. This is visible in `outbox_lag_seconds` and `outbox_publish_failures_total`.
- **Metrics are per instance and in memory**, reset on restart. Aggregation is left to the scraper. There is no OpenTelemetry or dashboard.
- **Worker correlation.** The original request `correlationId` is not persisted with the transaction, so events emitted by the `PENDING_REFERENCE` worker use the transaction id as `correlationId`.
- **Legacy data in a pre-existing database:**
  - `wager_transactions_failure_code_check` is added `NOT VALID`, because rows created by the first version have `REJECTED` without a `failure_code`. New and updated rows are validated.
  - Legacy wallets received `created_at`/`updated_at` equal to the migration time.
- **SIGTERM on Windows.** Signals are emulated by `TerminateProcess`, so graceful SIGTERM cannot be exercised with real signals there. The shutdown behavior is covered in-process (`consumer.stop()`, `app.close()`). On Linux containers `enableShutdownHooks()` handles SIGTERM.
- **Load testing** (`bun run test:load`) was not done.
- **Partial reversals** are out of scope, as the challenge states.
