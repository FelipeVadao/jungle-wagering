import { Migration } from '@mikro-orm/migrations';

export class Migration20261114215804 extends Migration {

  override name = 'Migration20261114215804';

  override up(): void | Promise<void> {
    this.addSql(`create table "outbox_events" ("id" uuid not null, "event_type" varchar(100) not null, "aggregate_id" uuid not null, "payload" jsonb not null, "status" varchar(20) not null default 'PENDING', "attempts" int not null default 0, "created_at" timestamptz not null, "published_at" timestamptz null, "last_error" text null, primary key ("id"));`);
    this.addSql(`create index "outbox_events_status_created_at_index" on "outbox_events" ("status", "created_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "outbox_events" cascade;`);
  }

}
