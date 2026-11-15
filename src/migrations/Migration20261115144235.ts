
import { Migration } from '@mikro-orm/migrations';

export class Migration20261115144235 extends Migration {
  override name = 'Migration20261115144235';

  override up(): void | Promise<void> {
    // Remove temporariamente a restrição para atualizar o schema.
    this.addSql(`
      alter table "wager_transactions"
      drop constraint "wager_transactions_status_check";
    `);

    // Adiciona os novos campos das transações.
    this.addSql(`
      alter table "wager_transactions"
      add "round_id" varchar(255) null,
      add "game_id" varchar(255) null,
      add "reference_external_transaction_id" varchar(255) null,
      add "failure_code" varchar(100) null,
      add "processed_at" timestamptz null;
    `);

    // Atualiza os status permitidos.
    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_status_check"
      check ("status" in (
        'PENDING',
        'PENDING_REFERENCE',
        'PROCESSED',
        'REJECTED',
        'FAILED'
      ));
    `);

    // Adiciona as novas colunas inicialmente aceitando NULL.
    this.addSql(`
      alter table "ledger_entries"
      add "direction" varchar(10) null,
      add "balance_before" numeric(20,2) null;
    `);

    // Recupera os dados históricos dos lançamentos existentes.
    this.addSql(`
      update "ledger_entries"
      set
        "direction" = case
          when "type" = 'BET' then 'DEBIT'
          when "type" = 'WIN' then 'CREDIT'
          else null
        end,
        "balance_before" = case
          when "type" = 'BET' then "balance_after" + "amount"
          when "type" = 'WIN' then "balance_after" - "amount"
          else null
        end;
    `);

    // Garante que todos os registros tenham os novos campos preenchidos.
    this.addSql(`
      alter table "ledger_entries"
      alter column "direction" set not null,
      alter column "balance_before" set not null;
    `);

    // Preserva a restrição dos tipos de lançamentos.
    this.addSql(`
      alter table "ledger_entries"
      drop constraint "ledger_entries_type_check";
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "ledger_entries_type_check"
      check ("type" in (
        'OPENING',
        'BET',
        'WIN',
        'REFUND',
        'ROLLBACK'
      ));
    `);
  }

  override down(): void | Promise<void> {
    // Restaura a restrição anterior de tipos.
    this.addSql(`
      alter table "ledger_entries"
      drop constraint "ledger_entries_type_check";
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "ledger_entries_type_check"
      check ("type" in (
        'OPENING',
        'BET',
        'WIN',
        'REFUND',
        'ROLLBACK'
      ));
    `);

    // Remove os campos adicionados ao ledger.
    this.addSql(`
      alter table "ledger_entries"
      drop column "direction",
      drop column "balance_before";
    `);

    // Restaura a restrição anterior de status.
    this.addSql(`
      alter table "wager_transactions"
      drop constraint "wager_transactions_status_check";
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_status_check"
      check ("status" in (
        'PENDING',
        'PENDING_REFERENCE',
        'PROCESSED',
        'REJECTED'
      ));
    `);

    // Remove os campos adicionados às transações.
    this.addSql(`
      alter table "wager_transactions"
      drop column "round_id",
      drop column "game_id",
      drop column "reference_external_transaction_id",
      drop column "failure_code",
      drop column "processed_at";
    `);
  }
}
