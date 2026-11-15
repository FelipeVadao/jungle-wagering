import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './support/app';

describe('App (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health/live responde sem autenticação', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready verifica PostgreSQL e SQS', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.checks.database.status).toBe('up');
    expect(response.body.checks.sqs.status).toBe('up');
  });

  it('GET /metrics expõe as métricas obrigatórias em formato Prometheus', async () => {
    const response = await request(app.getHttpServer()).get('/metrics').expect(200);

    for (const metric of [
      'wager_transactions_total',
      'idempotency_duplicates_total',
      'sqs_message_retries_total',
      'sqs_messages_dead_lettered_total',
      'wallet_lock_conflicts_total',
      'outbox_lag_seconds',
      'wager_processing_duration_seconds',
    ]) {
      expect(response.text).toContain(`# TYPE ${metric}`);
    }
  });

  it('propaga X-Correlation-Id', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/live')
      .set('X-Correlation-Id', 'corr-123')
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe('corr-123');
  });
});
