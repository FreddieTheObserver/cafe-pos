import type { KioskEvents, KioskOrderEvent } from '../src';

export const createFakeEvents = () => {
  const handlers = new Map<string, Set<(arg?: any) => void>>();
  const add = (name: string, cb: (arg?: any) => void) => {
    const set = handlers.get(name) ?? new Set();
    set.add(cb);
    handlers.set(name, set);
    return () => void set.delete(cb);
  };
  const events: KioskEvents = {
    on: (event: KioskOrderEvent, cb) => add(event, cb),
    onConnect: (cb) => add('connect', cb),
  };
  return {
    events,
    emit: (name: KioskOrderEvent | 'connect', arg?: { id: string }) =>
      [...(handlers.get(name) ?? [])].forEach((cb) => cb(arg)),
    listeners: () =>
      [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
};
