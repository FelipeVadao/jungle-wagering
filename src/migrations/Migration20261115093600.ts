import { Migration } from '@mikro-orm/migrations';

export class Migration20261115093600 extends Migration {
  override name = 'Migration20261115093600';

  override up(): void | Promise<void> {
    // Permite registrar a transação original de REFUND e ROLLBACK.
    this.addSql(`
      alter table "wager_transactions"
      add column "reference_transaction_id" uuid null;
    `);

    // Índice para localizar rapidamente operações pela referência.
    this.addSql(`
      create index "wager_transactions_reference_transaction_id_index"
      on "wager_transactions" ("reference_transaction_id");
    `);

    // Atualiza os status permitidos.
    this.addSql(`
      alter table "wager_transactions"
      drop constraint "wager_transactions_status_check";
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_status_check"
      check (
        "status" in (
          'PENDING',
          'PENDING_REFERENCE',
          'PROCESSED',
          'REJECTED'
        )
      );
    `);

    // Formaliza os tipos de lançamento aceitos pelo ledger.
    this.addSql(`
      alter table "ledger_entries"
      add constraint "ledger_entries_type_check"
      check (
        "type" in (
          'OPENING',
          'BET',
          'WIN',
          'REFUND',
          'ROLLBACK'
        )
      );
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      alter table "ledger_entries"
      drop constraint "ledger_entries_type_check";
    `);

    this.addSql(`
      alter table "wager_transactions"
      drop constraint "wager_transactions_status_check";
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_status_check"
      check (
        "status" in (
          'PENDING',
          'PROCESSED',
          'REJECTED'
        )
      );
    `);

    this.addSql(`
      drop index "wager_transactions_reference_transaction_id_index";
    `);

    this.addSql(`
      alter table "wager_transactions"
      drop column "reference_transaction_id";
    `);
  }
}
