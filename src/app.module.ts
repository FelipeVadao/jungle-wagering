import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { CorrelationIdMiddleware } from './common/http/correlation-id.middleware';
import { HttpErrorFilter } from './common/http/http-error.filter';
import { createValidationPipe } from './common/http/validation';
import { databaseOptions } from './database.config';
import { HealthModule } from './health/health.module';
import { MessagingModule } from './messaging/messaging.module';
import { ObservabilityModule } from './observability/observability.module';
import { WageringModule } from './wagering/wagering.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        databaseOptions((key) => config.get<string>(key)),
    }),

    ObservabilityModule,
    MessagingModule,
    WalletsModule,
    WageringModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*path');
  }
}
