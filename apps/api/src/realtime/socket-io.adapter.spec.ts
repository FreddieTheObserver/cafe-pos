import type { INestApplicationContext } from '@nestjs/common';
import type { Server } from 'socket.io';
import { RedisIoAdapter } from './socket-io.adapter';

const client = () => ({
  status: 'ready',
  quit: jest.fn().mockResolvedValue('OK'),
  disconnect: jest.fn(),
});

const server = () =>
  ({ close: (done: () => void) => done() }) as unknown as Server;

function adapterWith(pub: unknown, sub: unknown): RedisIoAdapter {
  const adapter = new RedisIoAdapter({} as INestApplicationContext, []);
  Object.assign(adapter, { pub, sub });
  return adapter;
}

describe('RedisIoAdapter shutdown', () => {
  it('quits each client once, after every server has closed', async () => {
    const pub = client();
    const sub = client();
    const adapter = adapterWith(pub, sub);

    // Nest closes every gateway server at once, then disposes the adapter.
    await Promise.all([
      adapter.close(server()),
      adapter.close(server()),
      adapter.close(server()),
    ]);
    expect(pub.quit).not.toHaveBeenCalled();
    expect(sub.quit).not.toHaveBeenCalled();

    await adapter.dispose();
    expect(pub.quit).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);
  });

  it('treats a second dispose as a no-op', async () => {
    const pub = client();
    const sub = client();
    const adapter = adapterWith(pub, sub);

    await Promise.all([adapter.dispose(), adapter.dispose()]);
    await adapter.dispose();

    expect(pub.quit).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);
  });
});
