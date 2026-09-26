# order-service

Order management microservice for the ecom platform. Exposes a gRPC API. Stores data in PostgreSQL via Prisma.

## Responsibilities

- Order creation with price/address snapshots from other services (gRPC)
- Order state machine (PENDING -> CONFIRMED -> SHIPPED -> DELIVERED, with CANCELLED)
- Consumes stock reservation results from Kafka
- Produces order lifecycle events via transactional outbox
- Status history tracking

## Development

```bash
npm install
npx prisma migrate dev
npm run start:dev
```

## Environment

See `.env.example` for required configuration.
