import { ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const PROJECT_ROOT = join(__dirname, '..', '..');

export interface Instance {
  name: string;
  url: string;
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

const MAX_OUTPUT = 200_000;

/**
 * Sobe um processo do SO separado (`bun <script>`), herdando o ambiente de
 * teste (banco `*_test` e filas `*-test.fifo`) com `extraEnv` por cima.
 */
export function spawnBun(
  name: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Omit<Instance, 'url'> {
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, LOG_FORMAT: 'json', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  const append = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString('utf8')).slice(-MAX_OUTPUT);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  return { name, child, output: () => buffer, exited };
}

/** Sobe uma instância completa da aplicação (HTTP + consumer + workers). */
export async function startInstance(
  name: string,
  port: number,
  extraEnv: Record<string, string> = {},
): Promise<Instance> {
  const instance = spawnBun(name, ['src/main.ts'], {
    PORT: String(port),
    SQS_CONSUMER_ENABLED: 'true',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    ...extraEnv,
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      throw new Error(`${name} exited during startup:\n${instance.output()}`);
    }

    try {
      const response = await fetch(`${url}/health/ready`);

      if (response.status === 200) {
        return { ...instance, url };
      }
    } catch {
      // ainda subindo
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  instance.child.kill();
  throw new Error(`${name} not ready in time:\n${instance.output()}`);
}

/** Encerra o processo abruptamente (no Windows: TerminateProcess). */
export async function killInstance(instance: Pick<Instance, 'child' | 'exited'>): Promise<void> {
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    instance.child.kill('SIGKILL');
  }

  await instance.exited;
}

/** Porta livre escolhida pelo SO (evita faixas reservadas no Windows). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();

  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
