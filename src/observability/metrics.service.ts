import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

interface MetricDefinition {
  type: 'counter' | 'gauge' | 'histogram';
  help: string;
  buckets?: number[];
}

interface HistogramValue {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

const DEFAULT_LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * Catálogo das métricas exigidas (seção 12). Valores são por instância;
 * em produção cada réplica é coletada separadamente (Prometheus scrape).
 */
const DEFINITIONS: Record<string, MetricDefinition> = {
  wager_transactions_total: {
    type: 'counter',
    help: 'Wager transactions by resulting status, kind and channel',
  },
  idempotency_duplicates_total: {
    type: 'counter',
    help: 'Duplicate requests detected (idempotent replays and inbox duplicates)',
  },
  idempotency_conflicts_total: {
    type: 'counter',
    help: 'Same idempotency key or messageId reused with a different payload',
  },
  sqs_message_retries_total: {
    type: 'counter',
    help: 'SQS messages returned to the queue for retry (transient failures)',
  },
  sqs_messages_dead_lettered_total: {
    type: 'counter',
    help: 'SQS messages moved to the DLQ, by reason',
  },
  wallet_lock_conflicts_total: {
    type: 'counter',
    help: 'Wallet lock contention (waits above threshold) and lock failures',
  },
  wallet_lock_wait_seconds: {
    type: 'histogram',
    help: 'Time spent waiting for the wallet row lock',
    buckets: DEFAULT_LATENCY_BUCKETS,
  },
  wager_processing_duration_seconds: {
    type: 'histogram',
    help: 'End-to-end processing latency of a wager transaction',
    buckets: DEFAULT_LATENCY_BUCKETS,
  },
  outbox_lag_seconds: {
    type: 'gauge',
    help: 'Age of the oldest pending outbox event',
  },
  outbox_pending_events: {
    type: 'gauge',
    help: 'Pending outbox events observed by the publisher',
  },
  outbox_published_total: {
    type: 'counter',
    help: 'Outbox events published to SQS',
  },
  outbox_publish_failures_total: {
    type: 'counter',
    help: 'Outbox publish attempts that failed and were rescheduled',
  },
  pending_reference_retries_total: {
    type: 'counter',
    help: 'PENDING_REFERENCE resolution attempts by outcome',
  },
  reconciliation_runs_total: {
    type: 'counter',
    help: 'Wallet reconciliations by result',
  },
  reconciliation_mismatches_total: {
    type: 'counter',
    help: 'Wallets whose stored balance diverges from the ledger',
  },
};

@Injectable()
export class MetricsService {
  private readonly values = new Map<string, Map<string, number | HistogramValue>>();

  increment(name: string, labels: Labels = {}, value = 1): void {
    const series = this.series(name, 'counter');
    const key = labelKey(labels);
    series.set(key, ((series.get(key) as number | undefined) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    this.series(name, 'gauge').set(labelKey(labels), value);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const definition = DEFINITIONS[name];
    const series = this.series(name, 'histogram');
    const key = labelKey(labels);
    const buckets = definition.buckets ?? DEFAULT_LATENCY_BUCKETS;

    let histogram = series.get(key) as HistogramValue | undefined;

    if (!histogram) {
      histogram = {
        buckets,
        counts: buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      series.set(key, histogram);
    }

    buckets.forEach((bound, index) => {
      if (value <= bound) {
        histogram.counts[index] += 1;
      }
    });

    histogram.sum += value;
    histogram.count += 1;
  }

  /** Exposição no formato texto do Prometheus. */
  render(): string {
    const lines: string[] = [];

    for (const [name, definition] of Object.entries(DEFINITIONS)) {
      lines.push(`# HELP ${name} ${definition.help}`);
      lines.push(`# TYPE ${name} ${definition.type}`);

      for (const [key, value] of this.values.get(name) ?? []) {
        if (typeof value === 'number') {
          lines.push(`${name}${key} ${value}`);
          continue;
        }

        value.buckets.forEach((bound, index) => {
          lines.push(`${name}_bucket${mergeLabels(key, `le="${bound}"`)} ${value.counts[index]}`);
        });
        lines.push(`${name}_bucket${mergeLabels(key, 'le="+Inf"')} ${value.count}`);
        lines.push(`${name}_sum${key} ${value.sum}`);
        lines.push(`${name}_count${key} ${value.count}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }

  private series(
    name: string,
    type: MetricDefinition['type'],
  ): Map<string, number | HistogramValue> {
    const definition = DEFINITIONS[name];

    if (!definition || definition.type !== type) {
      throw new Error(`Unknown ${type} metric: ${name}`);
    }

    let series = this.values.get(name);

    if (!series) {
      series = new Map();
      this.values.set(name, series);
    }

    return series;
  }
}

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return '';
  }

  return `{${entries
    .map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, '_')}"`)
    .join(',')}}`;
}

function mergeLabels(key: string, extra: string): string {
  return key ? `${key.slice(0, -1)},${extra}}` : `{${extra}}`;
}
