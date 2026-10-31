import {
  createApiClient,
  createKioskFeed,
  createServerClock,
  connectKiosk,
  kioskEvents,
  type ApiClient,
  type KioskEvents,
  type KioskFeedState,
} from '@cafepos/api-client';
import { useEffect, useRef, useState } from 'react';
import { createIdleTimer } from './idle';

export interface Connection {
  api: ApiClient;
  clock: ReturnType<typeof createServerClock>;
  events: KioskEvents;
  feed: KioskFeedState;
  pollMenu: () => Promise<void>;
  pollStatus: () => Promise<void>;
}

type Wiring = Omit<Connection, 'feed'>;

export const useConnection = (
  apiUrl: string,
  token: string,
): Connection | null => {
  const [wiring, setWiring] = useState<Wiring | null>(null);
  const [feed, setFeed] = useState<KioskFeedState>({
    menu: null,
    status: null,
    online: true,
  });

  useEffect(() => {
    const clock = createServerClock();
    const api = createApiClient({
      baseUrl: apiUrl,
      getToken: () => token,
      onServerTime: clock.sync,
    });
    const socket = connectKiosk(apiUrl, () => token);
    const controller = createKioskFeed({ api, onChange: setFeed });
    setWiring({
      api,
      clock,
      events: kioskEvents(socket),
      pollMenu: controller.pollMenu,
      pollStatus: controller.pollStatus,
    });
    controller.start();
    return () => {
      controller.stop();
      socket.disconnect();
      setWiring(null);
    };
  }, [apiUrl, token]);

  return wiring && { ...wiring, feed };
};

export const useIdle = (enabled: boolean, ms: number, onIdle: () => void) => {
  const latest = useRef(onIdle);
  latest.current = onIdle;
  useEffect(() => {
    if (!enabled) return;
    const timer = createIdleTimer(ms, () => latest.current());
    const events = ['pointerdown', 'keydown'] as const;
    timer.reset();
    for (const name of events) window.addEventListener(name, timer.reset);
    return () => {
      for (const name of events) window.removeEventListener(name, timer.reset);
      timer.stop();
    };
  }, [enabled, ms]);
};

export const useSecondsLeft = (
  clock: Connection['clock'],
  expiresAt: string | null,
): number | null => {
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setSeconds(clock.secondsUntil(expiresAt));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [clock, expiresAt]);
  return expiresAt ? seconds : null;
};
