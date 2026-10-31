import { io, type Socket } from 'socket.io-client';
import type { BoardEntry, KdsTicket } from './types';

/** Server → client events per namespace, from docs/api.md §7.3. */
export interface KdsServerEvents {
  'order.paid': (ticket: KdsTicket) => void;
  'order.updated': (ticket: KdsTicket) => void;
  'order.ready': (ticket: KdsTicket) => void;
}

export interface KioskServerEvents {
  'payment.succeeded': (ticket: KdsTicket) => void;
  'payment.failed': (ticket: KdsTicket) => void;
  'order.ready': (ticket: KdsTicket) => void;
}

export interface BoardServerEvents {
  'board.updated': (entries: BoardEntry[]) => void;
}

export type KdsSocket = Socket<KdsServerEvents, Record<string, never>>;
export type KioskSocket = Socket<KioskServerEvents, Record<string, never>>;
export type BoardSocket = Socket<BoardServerEvents, Record<string, never>>;

export const KDS_EVENT_NAMES = [
  'order.paid',
  'order.updated',
  'order.ready',
] as const;

export const connectKds = (
  baseUrl: string,
  getToken: () => string,
): KdsSocket =>
  io(`${baseUrl.replace(/\/+$/, '')}/kds`, {
    auth: (cb) => cb({ token: getToken() }),
    transports: ['websocket'],
  }) as KdsSocket;

export const connectKiosk = (
  baseUrl: string,
  getToken: () => string,
): KioskSocket =>
  io(`${baseUrl.replace(/\/+$/, '')}/kiosk`, {
    auth: (cb) => cb({ token: getToken() }),
    transports: ['websocket'],
  }) as KioskSocket;

export type KioskOrderEvent =
  'payment.succeeded' | 'payment.failed' | 'order.ready';

export interface KioskEvents {
  on(event: KioskOrderEvent, cb: (ticket: { id: string }) => void): () => void;
  onConnect(cb: () => void): () => void;
}

export const kioskEvents = (socket: KioskSocket): KioskEvents => ({
  on(event, cb) {
    socket.on(event, cb);
    return () => void socket.off(event, cb);
  },
  onConnect(cb) {
    socket.on('connect', cb);
    return () => void socket.off('connect', cb);
  },
});

export const connectBoard = (baseUrl: string): BoardSocket =>
  io(`${baseUrl.replace(/\/+$/, '')}/board`, {
    transports: ['websocket'],
  }) as BoardSocket;
