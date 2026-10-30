import { io, type Socket } from 'socket.io-client';
import { NAMESPACES } from '../src/realtime/realtime.constants';
import { IdentityHarness } from './fixtures/identity-fixtures';

async function eventually(
  assertion: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/**
 * §16: a deploy is zero-downtime. A stopping instance first reports itself
 * unready, so the load balancer moves new traffic away, waits out the drain,
 * and only then closes, dropping its sockets so each screen reconnects to the
 * instance that is staying up.
 */
describe('Shutdown (e2e)', () => {
  it('reports itself unready, waits out the drain, then drops its sockets', async () => {
    const harness = await IdentityHarness.boot({ shutdownDrainSeconds: 1 });
    expect((await harness.http().get('/readyz')).status).toBe(200);

    const socket: Socket = io(`${harness.url()}${NAMESPACES.kds}`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: await harness.tokenFor('BARISTA') },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    let droppedAt: number | undefined;
    socket.on('disconnect', () => {
      droppedAt = Date.now();
    });

    const started = Date.now();
    const closing = harness.close();

    await eventually(async () => {
      const res = await harness.http().get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: 'draining' });
    }, 900);
    // Still connected while draining: new traffic is moved away, old is not cut.
    expect(droppedAt).toBeUndefined();

    await closing;
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    // The client hears of it a moment after the server has finished closing.
    await eventually(() => {
      expect(droppedAt).toBeDefined();
      return Promise.resolve();
    }, 1000);
    socket.close();
  });
});
