import type Redis from 'ioredis';

/**
 * Shuts a Redis client down without letting an outage hang the process.
 *
 * `quit()` drains in-flight replies and is the right call for a healthy
 * client. On an unhealthy one it is a trap, in two different ways:
 *
 * - a client that has *given up* (`retryStrategy` returning null) rejects it
 *   outright, and a shutdown hook that throws turns an ordinary rollout into
 *   an error the orchestrator has to clean up after;
 * - a client still *reconnecting* — which is what the default retry policy
 *   does when Redis is simply down — queues the QUIT in the offline queue,
 *   where it waits for a connection that may never come. Shutdown then blocks
 *   on precisely the outage it is trying to survive.
 *
 * Checking `status` first is what separates the two: there is nothing to drain
 * on a client that is not `ready`, so close the socket and move on.
 */
export async function closeRedis(client: Redis): Promise<void> {
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
