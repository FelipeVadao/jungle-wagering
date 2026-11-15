import { Migration } from '@mikro-orm/migrations';

export class Migration20261114184634 extends Migration {

  override name = 'Migration20261114184634';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "idempotency_key" varchar(255) not null, add "request_hash" varchar(64) not null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_id_idempotency_key_unique" unique ("provider_id", "idempotency_key");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_provider_id_idempotency_key_unique";`);
    this.addSql(`alter table "wager_transactions" drop column "idempotency_key", drop column "request_hash";`);
  }

}
