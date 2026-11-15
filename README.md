# Jungle Wagering

Backend para processamento de transações de apostas, desenvolvido com **NestJS, TypeScript, PostgreSQL, MikroORM e Amazon SQS**, com foco em consistência financeira, idempotência e processamento assíncrono de mensagens.

Projeto desenvolvido como solução para o desafio técnico **Backend Developer Jr — Jungle Gaming**.

## Objetivo

Construir um sistema capaz de processar operações financeiras relacionadas a apostas, garantindo integridade dos saldos das carteiras, rastreabilidade das transações e confiabilidade no processamento de mensagens.

O sistema contempla as seguintes operações:

- **BET:** débito do valor da aposta na carteira.
- **WIN:** crédito de um prêmio.
- **LOSS:** registro de uma aposta perdida, sem movimentação financeira.
- **REFUND:** devolução de uma aposta anteriormente processada.
- **ROLLBACK:** reversão de uma transação elegível.

## Tecnologias utilizadas

| Tecnologia | Finalidade |
|---|---|
| Node.js | Ambiente de execução |
| TypeScript | Linguagem de programação |
| NestJS | Framework backend |
| PostgreSQL | Banco de dados relacional |
| MikroORM | Mapeamento objeto-relacional |
| Amazon SQS | Mensageria |
| MiniStack | Emulação local de serviços AWS |
| Docker Compose | Infraestrutura local |
| Bun | Gerenciamento de dependências e execução de scripts |
| Jest | Testes automatizados |

## Arquitetura

A aplicação utiliza uma arquitetura modular, organizada por responsabilidades.

### Wallets

- Criação e consulta de carteiras.
- Consulta de saldo.
- Registro de movimentações financeiras.
- Reconciliação de saldo.

### Wagering

- Processamento de transações.
- Validação das operações.
- Controle de idempotência.
- Aplicação das regras financeiras.
- Controle de operações de reversão.

### Messaging

- Integração com Amazon SQS.
- Publicação de mensagens.
- Processamento de comandos.
- Controle de mensagens processadas.
- Publicação de eventos por meio do padrão Outbox.

### Estratégias de confiabilidade

- **Idempotência:** evita que a mesma solicitação financeira seja processada mais de uma vez.
- **Transações SQL:** mantém operações relacionadas dentro de uma unidade transacional.
- **Pessimistic Locking:** protege atualizações concorrentes de carteiras.
- **Outbox Pattern:** registra eventos no banco de dados para publicação posterior.
- **Inbox Pattern:** auxilia no controle de mensagens duplicadas.
- **Dead-Letter Queue (DLQ):** recebe mensagens que falharam repetidamente.

## Estrutura do projeto

```text
jungle-wagering/
├── scripts/
│   ├── test-outbox.ts
│   └── test-sqs.ts
├── src/
│   ├── common/
│   │   └── domain/
│   ├── messaging/
│   │   ├── entities/
│   │   ├── messaging.module.ts
│   │   ├── outbox.publisher.ts
│   │   ├── sqs.service.ts
│   │   └── wager-command.consumer.ts
│   ├── migrations/
│   ├── wallets/
│   │   ├── domain/
│   │   ├── dto/
│   │   ├── entities/
│   │   ├── wallets.controller.ts
│   │   └── wallets.service.ts
│   ├── wagering/
│   │   ├── dto/
│   │   ├── entities/
│   │   ├── wagering.controller.ts
│   │   └── wagering.service.ts
│   ├── app.module.ts
│   └── main.ts
├── test/
├── .env.example
├── docker-compose.yml
├── mikro-orm.config.ts
├── package.json
└── README.md
```

## Pré-requisitos

- Node.js
- Bun
- Docker Desktop
- AWS CLI

O AWS CLI será utilizado para configurar e consultar as filas SQS disponibilizadas pelo MiniStack.

## Configuração do ambiente

### 1. Instalar dependências

Na raiz do projeto:

```powershell
bun install
```

### 2. Configurar variáveis de ambiente

Crie seu arquivo `.env` a partir do exemplo:

```powershell
Copy-Item .env.example .env
```

O arquivo `.env.example` contém as seguintes configurações:

```env
NODE_ENV=development
PORT=3000

DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=wagering
DB_USER=wagering_app
DB_PASSWORD=dev_password_change_me

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test

SQS_ENDPOINT=http://localhost:4566
SQS_COMMAND_QUEUE_URL=http://localhost:4566/000000000000/wager-commands.fifo
SQS_EVENT_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions.fifo
```

Revise as configurações conforme o ambiente de execução.

**Importante:** o arquivo `.env` contém configurações locais e não deve ser versionado.

### 3. Inicializar a infraestrutura

Execute:

```powershell
docker compose up -d
```

O Docker Compose inicializará:

- PostgreSQL 16.
- MiniStack para emulação local dos serviços AWS.

Para verificar os containers:

```powershell
docker compose ps
```

### 4. Configurar as filas SQS

Configure o caminho do AWS CLI e o endpoint local:

```powershell
$aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
$endpoint = "http://localhost:4566"
```

Crie as quatro filas FIFO:

```powershell
& $aws sqs create-queue `
  --queue-name wager-commands.fifo `
  --attributes FifoQueue=true,ContentBasedDeduplication=false `
  --endpoint-url $endpoint `
  --region us-east-1

& $aws sqs create-queue `
  --queue-name wager-commands-dlq.fifo `
  --attributes FifoQueue=true,ContentBasedDeduplication=false `
  --endpoint-url $endpoint `
  --region us-east-1

& $aws sqs create-queue `
  --queue-name wager-transactions.fifo `
  --attributes FifoQueue=true,ContentBasedDeduplication=false `
  --endpoint-url $endpoint `
  --region us-east-1

& $aws sqs create-queue `
  --queue-name wager-transactions-dlq.fifo `
  --attributes FifoQueue=true,ContentBasedDeduplication=false `
  --endpoint-url $endpoint `
  --region us-east-1
```

### 5. Configurar as políticas de Dead-Letter Queue

Depois de criar as filas, configure as políticas de redirecionamento.

Fila de comandos:

```powershell
& $aws sqs set-queue-attributes `
  --queue-url "$endpoint/000000000000/wager-commands.fifo" `
  --attributes file://command-redrive-policy.json `
  --endpoint-url $endpoint `
  --region us-east-1
```

Fila de eventos:

```powershell
& $aws sqs set-queue-attributes `
  --queue-url "$endpoint/000000000000/wager-transactions.fifo" `
  --attributes file://redrive-policy.json `
  --endpoint-url $endpoint `
  --region us-east-1
```

As políticas configuram:

- **Commands DLQ:** encaminhamento após 5 tentativas.
- **Transactions DLQ:** encaminhamento após 3 tentativas.

Para listar as filas:

```powershell
& $aws sqs list-queues `
  --endpoint-url $endpoint `
  --region us-east-1
```

## Banco de dados e migrações

Com a infraestrutura inicializada, execute as migrações:

```powershell
bun run migration:up
```

Para criar uma nova migração:

```powershell
bun run migration:create
```

Para reverter a última migração:

```powershell
bun run migration:down
```

## Executar a aplicação

### Ambiente de desenvolvimento

```powershell
bun run start:dev
```

A aplicação utiliza a porta configurada em `PORT`, cujo valor padrão no arquivo de exemplo é `3000`.

### Build

```powershell
bun run build
```

### Produção

Depois de gerar o build:

```powershell
bun run start:prod
```

## Testes

Executar a suíte de testes:

```powershell
bun run test
```

Executar testes end-to-end:

```powershell
bun run test:e2e
```

Executar testes com cobertura:

```powershell
bun run test:cov
```

Executar o linter:

```powershell
bun run lint
```

## Scripts auxiliares

O diretório `scripts/` contém ferramentas auxiliares para testes e validação da integração com os componentes de mensageria:

- `test-sqs.ts`
- `test-outbox.ts`

## Observações

- O ambiente local utiliza credenciais fictícias para comunicação com o MiniStack.
- As filas FIFO devem ser criadas antes de iniciar o processamento de mensagens.
- As políticas de redrive dependem da existência das respectivas filas DLQ.
- O arquivo `.env` não deve ser enviado ao GitHub.
- O projeto utiliza PostgreSQL e MiniStack para execução e testes locais.

## Licença

Projeto desenvolvido para fins de avaliação técnica no desafio Backend Developer Jr da Jungle Gaming.