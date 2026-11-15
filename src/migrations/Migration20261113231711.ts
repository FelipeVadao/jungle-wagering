import { Migration } from '@mikro-orm/migrations';

export class Migration20261113231711 extends Migration {

  override name = 'Migration20261113231711';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "wallet_id" uuid not null, "provider_id" varchar(255) not null, "external_transaction_id" varchar(255) not null, "type" text not null, "status" text not null, "amount" numeric(20,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wager_transactions_wallet_id_created_at_index" on "wager_transactions" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_id_external_transaction_id_unique" unique ("provider_id", "external_transaction_id");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_type_check" check ("type" in ('BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PROCESSED', 'REJECTED'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }

}
