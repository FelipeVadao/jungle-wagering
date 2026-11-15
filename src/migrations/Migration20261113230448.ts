import { Migration } from '@mikro-orm/migrations';

export class Migration20261113230448 extends Migration {

  override name = 'Migration20261113230448';

  override up(): void | Promise<void> {
    this.addSql(`create table "ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "type" varchar(20) not null, "amount" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "ledger_entries_wallet_id_created_at_index" on "ledger_entries" ("wallet_id", "created_at");`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_wallet_id_transaction_id_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "ledger_entries" cascade;`);
  }

}
