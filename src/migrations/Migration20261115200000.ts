import { Migration } from '@mikro-orm/migrations';

/**
 * Leva as garantias da seção 6 para o schema (não apenas para o código):
 *
 * - wallets: saldo nunca negativo, moeda ISO-4217, timestamps.
 * - wager_transactions: OPENING interno, moeda/player persistidos, saldo
 *   observado (replay), agendamento de PENDING_REFERENCE, FK de referência,
 *   no máximo uma reversão PROCESSED por referência, estados terminais
 *   imutáveis (trigger).
 * - ledger_entries: append-only (trigger bloqueia UPDATE/DELETE/TRUNCATE),
 *   aritmética balanceada, valores positivos, FK para a transação, no máximo
 *   um lançamento por transação, `sequence` para paginação estável.
 * - outbox_events: agendamento de retry e consistência status/published_at.
 * - inbox_messages: hash do payload e received_at.
 *
 * Constraints que dados legados podem violar entram como NOT VALID: valem
 * para toda linha nova/alterada sem exigir apagar histórico.
 */
export class Migration20261115200000 extends Migration {
  override name = 'Migration20261115200000';

  override up(): void | Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      alter table "wallets"
        add column "created_at" timestamptz not null default now(),
        add column "updated_at" timestamptz not null default now();
    `);
    this.addSql(`
      alter table "wallets"
        add constraint "wallets_balance_non_negative" check ("balance" >= 0),
        add constraint "wallets_currency_iso4217" check ("currency" ~ '^[A-Z]{3}$'),
        add constraint "wallets_version_non_negative" check ("version" >= 0);
    `);

    // ------------------------------------------------------ wager_transactions
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_type_check";
    `);
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_type_check"
        check ("type" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));
    `);
    this.addSql(`
      alter table "wager_transactions"
        add column "currency" varchar(3) null,
        add column "player_id" varchar(255) null,
        add column "balance_after" numeric(20,2) null,
        add column "attempts" int not null default 0,
        add column "next_attempt_at" timestamptz null;
    `);
    // Backfill a partir da wallet (dados legados não tinham as colunas).
    this.addSql(`
      update "wager_transactions" t
        set "currency" = w."currency", "player_id" = w."player_id"
        from "wallets" w
        where w."id" = t."wallet_id";
    `);
    this.addSql(`
      update "wager_transactions" t
        set "balance_after" = l."balance_after"
        from "ledger_entries" l
        where l."transaction_id" = t."id";
    `);
    this.addSql(`
      alter table "wager_transactions"
        alter column "currency" set not null,
        alter column "player_id" set not null;
    `);
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_amount_check"
          check ("amount" >= 0 and ("type" = 'LOSS' or "amount" > 0)),
        add constraint "wager_transactions_currency_iso4217"
          check ("currency" ~ '^[A-Z]{3}$'),
        add constraint "wager_transactions_attempts_non_negative"
          check ("attempts" >= 0),
        add constraint "wager_transactions_reference_required"
          check ("type" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null),
        add constraint "wager_transactions_balance_after_non_negative"
          check ("balance_after" is null or "balance_after" >= 0);
    `);
    // Toda rejeição/falha carrega failureCode (legado anterior à coluna é isento).
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_failure_code_check"
        check (("status" in ('REJECTED', 'FAILED')) = ("failure_code" is not null))
        not valid;
    `);
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_reference_transaction_id_foreign"
        foreign key ("reference_transaction_id") references "wager_transactions" ("id")
        on delete restrict deferrable initially deferred;
    `);
    // Uma referência só pode ser revertida uma vez (REFUND e ROLLBACK juntos).
    this.addSql(`
      create unique index "wager_transactions_single_reversal_unique"
        on "wager_transactions" ("reference_transaction_id")
        where "type" in ('REFUND', 'ROLLBACK') and "status" = 'PROCESSED';
    `);
    this.addSql(`
      create index "wager_transactions_pending_reference_due_index"
        on "wager_transactions" ("next_attempt_at")
        where "status" = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create or replace function "wager_transactions_guard_terminal"()
      returns trigger language plpgsql as $$
      begin
        if old."status" in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%) and cannot be modified', old."id", old."status"
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger "wager_transactions_terminal_guard"
        before update on "wager_transactions"
        for each row execute function "wager_transactions_guard_terminal"();
    `);

    // ---------------------------------------------------------- ledger_entries
    this.addSql(`
      alter table "ledger_entries"
        add column "sequence" bigint generated always as identity;
    `);
    this.addSql(`
      alter table "ledger_entries"
        add constraint "ledger_entries_sequence_unique" unique ("sequence"),
        add constraint "ledger_entries_transaction_id_unique" unique ("transaction_id"),
        add constraint "ledger_entries_direction_check"
          check ("direction" in ('DEBIT', 'CREDIT')),
        add constraint "ledger_entries_amount_positive" check ("amount" > 0),
        add constraint "ledger_entries_balances_non_negative"
          check ("balance_before" >= 0 and "balance_after" >= 0),
        add constraint "ledger_entries_balanced"
          check (
            ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
            or ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
          );
    `);
    this.addSql(`
      alter table "ledger_entries"
        add constraint "ledger_entries_transaction_id_foreign"
        foreign key ("transaction_id") references "wager_transactions" ("id")
        on delete restrict deferrable initially deferred;
    `);
    this.addSql(`
      create index "ledger_entries_wallet_id_sequence_index"
        on "ledger_entries" ("wallet_id", "sequence");
    `);
    this.addSql(`
      create or replace function "ledger_entries_append_only"()
      returns trigger language plpgsql as $$
      begin
        raise exception 'ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'integrity_constraint_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger "ledger_entries_no_update_delete"
        before update or delete on "ledger_entries"
        for each row execute function "ledger_entries_append_only"();
    `);
    this.addSql(`
      create trigger "ledger_entries_no_truncate"
        before truncate on "ledger_entries"
        for each statement execute function "ledger_entries_append_only"();
    `);

    // ----------------------------------------------------------- outbox_events
    this.addSql(`
      alter table "outbox_events"
        add column "next_attempt_at" timestamptz not null default now();
    `);
    this.addSql(`
      alter table "outbox_events"
        add constraint "outbox_events_status_check"
          check ("status" in ('PENDING', 'PUBLISHED')),
        add constraint "outbox_events_published_at_check"
          check (("status" = 'PUBLISHED') = ("published_at" is not null)),
        add constraint "outbox_events_attempts_non_negative"
          check ("attempts" >= 0);
    `);
    this.addSql(`
      create index "outbox_events_pending_due_index"
        on "outbox_events" ("next_attempt_at", "created_at")
        where "status" = 'PENDING';
    `);
    // Suporta a verificação "há evento anterior do mesmo agregado em backoff?".
    this.addSql(`
      create index "outbox_events_pending_aggregate_index"
        on "outbox_events" ("aggregate_id", "created_at", "id")
        where "status" = 'PENDING';
    `);

    // ---------------------------------------------------------- inbox_messages
    this.addSql(`
      alter table "inbox_messages"
        add column "payload_hash" varchar(64) null,
        add column "received_at" timestamptz not null default now();
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      alter table "inbox_messages"
        drop column "received_at",
        drop column "payload_hash";
    `);

    this.addSql(`drop index if exists "outbox_events_pending_aggregate_index";`);
    this.addSql(`drop index if exists "outbox_events_pending_due_index";`);
    this.addSql(`
      alter table "outbox_events"
        drop constraint "outbox_events_attempts_non_negative",
        drop constraint "outbox_events_published_at_check",
        drop constraint "outbox_events_status_check",
        drop column "next_attempt_at";
    `);

    this.addSql(`drop trigger if exists "ledger_entries_no_truncate" on "ledger_entries";`);
    this.addSql(`drop trigger if exists "ledger_entries_no_update_delete" on "ledger_entries";`);
    this.addSql(`drop function if exists "ledger_entries_append_only"();`);
    this.addSql(`drop index if exists "ledger_entries_wallet_id_sequence_index";`);
    this.addSql(`
      alter table "ledger_entries"
        drop constraint "ledger_entries_transaction_id_foreign",
        drop constraint "ledger_entries_balanced",
        drop constraint "ledger_entries_balances_non_negative",
        drop constraint "ledger_entries_amount_positive",
        drop constraint "ledger_entries_direction_check",
        drop constraint "ledger_entries_transaction_id_unique",
        drop constraint "ledger_entries_sequence_unique",
        drop column "sequence";
    `);

    this.addSql(`drop trigger if exists "wager_transactions_terminal_guard" on "wager_transactions";`);
    this.addSql(`drop function if exists "wager_transactions_guard_terminal"();`);
    this.addSql(`drop index if exists "wager_transactions_pending_reference_due_index";`);
    this.addSql(`drop index if exists "wager_transactions_single_reversal_unique";`);
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_reference_transaction_id_foreign",
        drop constraint "wager_transactions_failure_code_check",
        drop constraint "wager_transactions_balance_after_non_negative",
        drop constraint "wager_transactions_reference_required",
        drop constraint "wager_transactions_attempts_non_negative",
        drop constraint "wager_transactions_currency_iso4217",
        drop constraint "wager_transactions_amount_check",
        drop column "next_attempt_at",
        drop column "attempts",
        drop column "balance_after",
        drop column "player_id",
        drop column "currency";
    `);
    // Linhas OPENING não existiam no schema anterior; o down falha
    // explicitamente se houver alguma, em vez de apagar dados financeiros.
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_type_check";
    `);
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_type_check"
        check ("type" in ('BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));
    `);

    this.addSql(`
      alter table "wallets"
        drop constraint "wallets_version_non_negative",
        drop constraint "wallets_currency_iso4217",
        drop constraint "wallets_balance_non_negative",
        drop column "updated_at",
        drop column "created_at";
    `);
  }
}
