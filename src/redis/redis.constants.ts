/** DI token for the shared ioredis client. Inject with `@Inject(REDIS)`. */
export const REDIS = Symbol('REDIS');
