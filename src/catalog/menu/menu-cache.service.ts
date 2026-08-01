import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../redis/redis.constants';

/** Monotonic counter; every catalog write moves it (§10, the cache table). */
const VERSION_KEY = 'catalog:version';
const DOCUMENT_KEY_PREFIX = 'catalog:menu:v';

/**
 * Rendered documents are keyed by version, so a stale one is unreachable the
 * moment the version moves rather than needing eviction. The TTL exists only to
 * stop superseded versions accumulating.
 */
const DOCUMENT_TTL_SECONDS = 3600;

/**
 * The `GET /menu` cache (§10): a version counter plus the rendered JSON for
 * each version.
 *
 * **Every method fails open.** Redis is a cache here, not a system of record —
 * if it is unreachable, `currentVersion` returns null, the caller skips both
 * the cached document and the ETag, and serves a freshly built menu from
 * Postgres. A menu that is slower is a worse cafe; a menu that 500s is a closed
 * one, and §11.2 already names Redis as a component the API must survive.
 *
 * The one case this trades away: a bump that fails while reads still succeed
 * leaves kiosks on a stale menu until the TTL expires. FR-3 degrades, but the
 * money path does not — E6 revalidates availability when the order is actually
 * submitted, so a sold-out item is refused at ordering time regardless of what
 * the kiosk was showing.
 */
@Injectable()
export class MenuCacheService {
  private readonly logger = new Logger(MenuCacheService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * The version every other method is keyed by, or null when Redis is down.
   *
   * A missing counter is created rather than treated as a cache miss, so the
   * first request after a cold Redis still gets an ETag. Two instances racing
   * here simply land on different starting numbers, which costs one extra
   * download and nothing else.
   */
  async currentVersion(): Promise<string | null> {
    try {
      const version = await this.redis.get(VERSION_KEY);
      return version ?? String(await this.redis.incr(VERSION_KEY));
    } catch (error) {
      this.warn('read the catalog version', error);
      return null;
    }
  }

  async read(version: string): Promise<string | null> {
    try {
      return await this.redis.get(DOCUMENT_KEY_PREFIX + version);
    } catch (error) {
      this.warn('read the cached menu', error);
      return null;
    }
  }

  async write(version: string, document: string): Promise<void> {
    try {
      await this.redis.set(
        DOCUMENT_KEY_PREFIX + version,
        document,
        'EX',
        DOCUMENT_TTL_SECONDS,
      );
    } catch (error) {
      this.warn('cache the menu', error);
    }
  }

  /** Invalidates every cached document by making a new version current. */
  async bump(): Promise<void> {
    try {
      await this.redis.incr(VERSION_KEY);
    } catch (error) {
      this.warn('bump the catalog version', error);
    }
  }

  private warn(action: string, error: unknown): void {
    this.logger.warn(
      `Could not ${action}; serving the menu uncached. ${String(error)}`,
    );
  }
}
