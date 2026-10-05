# order-service

Order management microservice for the ecom platform. Exposes a gRPC API (`ecom.order.v1.OrderService`). Stores data in PostgreSQL via Prisma.

## Status

| Task                                          | Status |
| --------------------------------------------- | ------ |
| ORD-1 Scaffold                                | Done   |
| ORD-2 Prisma schema                           | Done   |
| ORD-3 gRPC clients (product, user)            | Done   |
| ORD-4 CreateOrder                             | Done   |
| ORD-5 State machine                           | Done   |
| ORD-6 GetOrder / ListMyOrders / ListAllOrders | Done   |
| ORD-7 CancelOrder / ShipOrder / DeliverOrder  | Done   |
| ORD-8 Outbox relay                            | Done   |
| ORD-9 Tests                                   | Done   |
| KFK-1 Kafka consumer wrapper                  | Done   |
| KFK-4 Consume stock results                   | Done   |
| KFK-8 Consumer retry + poison logging         | Done   |
| KFK-9 correlationId propagation               | Done   |

Kafka (`KFK-4`): `order.stock-reserved` moves the order `PENDING → CONFIRMED` and enqueues `order.confirmed`. `order.stock-reservation-failed` moves it `PENDING → CANCELLED` and enqueues `order.cancelled`. Each handler writes the inbox row (`processed_events`), the transition and the outbox event in one Prisma transaction. A result for an order that has already left `PENDING` (for example, the user cancelled while stock was being reserved) is recorded in the inbox and ignored, not retried. product-service releases the stock when it consumes that `order.cancelled`.

## Responsibilities

- Order creation with price/address snapshots from other services (gRPC)
- Order state machine (PENDING → CONFIRMED → SHIPPED → DELIVERED, with CANCELLED)
- Consumes stock reservation results from Kafka
- Produces order lifecycle events via transactional outbox
- Status history tracking

## Endpoints

### gRPC (`:5003`)

All RPCs are in the `ecom.order.v1.OrderService` package. Every RPC requires the gateway's `x-user-id` / `x-user-role` metadata (`UNAUTHENTICATED` otherwise). Orders the caller does not own answer `NOT_FOUND`, never `PERMISSION_DENIED`, so order ids can't be probed.

`CreateOrder` calls user-service `GetAddress` and product-service `GetProductsByIds` **on behalf of the caller** (identity metadata is forwarded), so another user's address id is `NOT_FOUND`. Items: 1–100 lines, distinct ObjectId product ids, quantity 1–10 000. Products must be active, priced, and share one currency; the total must fit in int32 minor units. If a downstream service is unreachable or times out, the RPC answers `UNAVAILABLE`.

Status changes go through `OrderStateMachine`, which locks the order row (`SELECT … FOR UPDATE`) so concurrent transitions serialise; an illegal transition is `FAILED_PRECONDITION`. Every transition writes an `order_status_history` row and an outbox event in the same transaction.

| RPC             | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `CreateOrder`   | Place a new order (validates items, snapshots prices/address) |
| `GetOrder`      | Get a single order by id                                      |
| `ListMyOrders`  | List the caller's orders (ownership via metadata)             |
| `ListAllOrders` | List all orders (admin only)                                  |
| `CancelOrder`   | Cancel a PENDING or CONFIRMED order                           |
| `ShipOrder`     | Mark an order as shipped (admin)                              |
| `DeliverOrder`  | Mark an order as delivered (admin)                            |

### HTTP (`:8083`)

| Path               | Description                           |
| ------------------ | ------------------------------------- |
| `GET /health`      | Readiness — pings Postgres via Prisma |
| `GET /health/live` | Liveness — always `{ status: "ok" }`  |

## Development

```bash
npm install
npx prisma migrate dev
npm run start:dev
```

## Scripts

| Script                          | Description                                       |
| ------------------------------- | ------------------------------------------------- |
| `npm run build`                 | Compile TypeScript (runs `prisma generate` first) |
| `npm start`                     | Run compiled app                                  |
| `npm run start:dev`             | Run with ts-node (transpile-only)                 |
| `npm run prisma:migrate:dev`    | Create and apply dev migrations                   |
| `npm run prisma:migrate:deploy` | Apply pending migrations (production)             |
| `npm run lint`                  | ESLint                                            |
| `npm run format:check`          | Prettier check                                    |
| `npm test`                      | Jest                                              |

## Environment

| Variable                        | Default          | Description                           |
| ------------------------------- | ---------------- | ------------------------------------- |
| `NODE_ENV`                      | `development`    | Runtime environment                   |
| `LOG_LEVEL`                     | `info`           | Pino log level                        |
| `GRPC_HOST`                     | `0.0.0.0`        | gRPC bind host                        |
| `GRPC_PORT`                     | `5003`           | gRPC listen port                      |
| `HTTP_HOST`                     | `0.0.0.0`        | HTTP bind host                        |
| `HTTP_PORT`                     | `8083`           | HTTP listen port (health only)        |
| `DATABASE_URL`                  | —                | Postgres connection string (required) |
| `KAFKA_BROKERS`                 | `localhost:9092` | Kafka bootstrap servers               |
| `KAFKA_CLIENT_ID`               | `order-service`  | Kafka client identifier               |
| `KAFKA_CONSUMER_GROUP_ID`       | `order-service`  | Consumer group for stock results      |
| `KAFKA_CONSUMER_MAX_RETRIES`    | `5`              | Handler attempts before poison skip   |
| `KAFKA_CONSUMER_RETRY_BASE_MS`  | `1000`           | First retry backoff (doubles)         |
| `KAFKA_CONSUMER_RETRY_MAX_MS`   | `30000`          | Backoff cap                           |
| `OUTBOX_RELAY_ENABLED`          | `true`           | Enable outbox relay polling           |
| `OUTBOX_RELAY_POLL_INTERVAL_MS` | `250`            | Relay poll interval                   |
| `OUTBOX_RELAY_BATCH_SIZE`       | `32`             | Rows per relay tick                   |
| `OUTBOX_RELAY_ERROR_BACKOFF_MS` | `5000`           | Backoff on relay error                |
| `USER_SERVICE_URL`              | `localhost:5001` | User-service gRPC address             |
| `PRODUCT_SERVICE_URL`           | `localhost:5002` | Product-service gRPC address          |

## Docker

Multi-stage build (`node:24.21.0-alpine`). Entrypoint runs `prisma migrate deploy` before starting the app. Health check hits `/health` on the HTTP port.

```bash
docker build -t order-service .
```

Inside `docker compose up` (via `infra/`), the service starts after `order-db` is healthy and Kafka is ready.
