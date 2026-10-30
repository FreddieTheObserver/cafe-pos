import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { describeError } from '../common/errors/describe-error';
import {
  parseRevocation,
  type Revocation,
} from '../identity/revocation/revocation.service';
import { closeRedis } from '../redis/close-redis';
import { REDIS } from '../redis/redis.constants';
import { attachRedisDiagnostics } from '../redis/redis.diagnostics';
import { REVOCATION_CHANNEL } from './realtime.constants';

/** Told that a principal's sessions must end now. */
export type RevocationHandler = (revocation: Revocation) => void;

/**
 * One subscriber for the kill channel, shared by every namespace.
 *
 * Each gateway owning its own would mean a Redis connection per audience for a
 * channel that carries a handful of messages a day, and — worse — three copies
 * of the parse-and-dispatch logic, which is exactly the sort of duplication
 * that lets one of them quietly stop honouring revocations.
 */
@Injectable()
export class RevocationSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RevocationSubscriber');
  private readonly handlers: RevocationHandler[] = [];
  private subscriber?: Redis;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Registered by a gateway at init; never removed, since gateways outlive it. */
  onRevocation(handler: RevocationHandler): void {
    this.handlers.push(handler);
  }

  onModuleInit(): void {
    /**
     * Its own connection because a client in subscriber mode cannot run
     * ordinary commands — sharing the app's client would break the cache and
     * the rate limiter the moment this subscribes.
     */
    this.subscriber = this.redis.duplicate();
    attachRedisDiagnostics(this.subscriber, this.logger);

    this.subscriber.on('message', (_channel, raw: string) => {
      const revocation = parseRevocation(raw);
      if (revocation === null) {
        this.logger.warn('Ignoring an unreadable message on the kill channel.');
        return;
      }

      for (const handler of this.handlers) {
        try {
          handler(revocation);
        } catch (error) {
          // One namespace failing to cut its sockets must not stop the others
          // from cutting theirs.
          this.logger.error(
            `A revocation handler threw; other namespaces still ran. ${describeError(error)}`,
          );
        }
      }
    });

    /**
     * Subscribed on `ready`, never awaited here.
     *
     * Awaiting made a Redis outage at boot fatal: the subscribe rejects,
     * module init rejects with it, and the whole API refuses to start over a
     * dependency every other consumer degrades around. `ready` fires on the
     * first connection and on every reconnection after, so the subscription
     * also re-establishes itself when Redis comes back rather than leaving
     * this instance silently ignoring revocations for the life of the process.
     */
    this.subscriber.on('ready', () => {
      this.subscriber
        ?.subscribe(REVOCATION_CHANNEL)
        .catch((error: unknown) =>
          this.logger.error(
            `Could not subscribe to the kill channel; revocations will not reach this instance until Redis recovers. ${describeError(error)}`,
          ),
        );
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) return;
    // Not a bare `quit()`: a subscriber still reconnecting would queue it and
    // block shutdown on the outage. `closeRedis` is where that reasoning lives.
    await closeRedis(this.subscriber);
  }
}
