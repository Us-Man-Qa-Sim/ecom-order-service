import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLISHER, Publisher } from '../kafka/publisher';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Prisma.JsonValue;
  created_at: Date;
}

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly errorBackoffMs: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    @Inject(PUBLISHER) private readonly publisher: Publisher,
  ) {
    this.enabled = config.get('OUTBOX_RELAY_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('OUTBOX_RELAY_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_RELAY_BATCH_SIZE', { infer: true });
    this.errorBackoffMs = config.get('OUTBOX_RELAY_ERROR_BACKOFF_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Outbox relay disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    this.logger.log(
      `Outbox relay started (batch=${this.batchSize}, poll=${this.pollIntervalMs}ms)`,
    );
    this.scheduleNextTick(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const start = Date.now();
    while (this.running && Date.now() - start < 10_000) {
      await sleep(50);
    }
    if (this.running) {
      this.logger.warn('Shutdown timed out with a relay tick still in flight');
    }
  }

  async drainOnce(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, aggregate_id, event_type, payload, created_at
        FROM outbox
        WHERE sent_at IS NULL
        ORDER BY created_at
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return 0;

      for (const row of rows) {
        const envelope = row.payload as Record<string, unknown>;
        const correlationId =
          typeof envelope.correlationId === 'string'
            ? envelope.correlationId
            : undefined;

        await this.publisher.publish({
          topic: row.event_type,
          key: row.aggregate_id,
          value: JSON.stringify(row.payload),
          headers: correlationId
            ? { 'x-correlation-id': correlationId }
            : undefined,
        });
      }

      await tx.outbox.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { sentAt: new Date() },
      });

      return rows.length;
    });
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    try {
      const processed = await this.drainOnce();
      const nextDelay = processed === this.batchSize ? 0 : this.pollIntervalMs;
      this.scheduleNextTick(nextDelay);
    } catch (err) {
      this.logger.error({ err }, 'Outbox relay tick failed');
      this.scheduleNextTick(this.errorBackoffMs);
    } finally {
      this.running = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
