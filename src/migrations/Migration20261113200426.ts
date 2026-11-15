import { Migration } from '@mikro-orm/migrations';

export class Migration20261113200426 extends Migration {

  override name = 'Migration20261113200426';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wallets" drop constraint "wallets_player_id_currency_unique";`);
  }

}
