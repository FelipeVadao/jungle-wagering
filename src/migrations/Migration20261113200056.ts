import { Migration } from '@mikro-orm/migrations';

export class Migration20261113200056 extends Migration {

  override name = 'Migration20261113200056';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" varchar(255) not null, "currency" varchar(3) not null, "balance" numeric(20,2) not null default '0.00', "version" int not null default 0, primary key ("id"));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }

}
