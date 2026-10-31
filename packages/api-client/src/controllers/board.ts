import { initialBoard, replaceBoard, type BoardState } from '../state/board';
import type { BoardEntry } from '../types';

/** The slice of a Socket.IO client the controller needs, so tests can fake it. */
export interface BoardTransport {
  on(event: 'board.updated', cb: (entries: BoardEntry[]) => void): unknown;
  on(event: 'connect', cb: () => void): unknown;
  on(event: 'disconnect', cb: () => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
}

export interface BoardControllerOptions {
  socket: BoardTransport;
  fetchSnapshot: () => Promise<BoardEntry[]>;
  onChange: (state: BoardState, connected: boolean) => void;
  /** Safety net if the socket stays down; the board is public and cheap to poll. */
  pollMs?: number;
}

/**
 * Keeps a board screen correct. Loads the snapshot on every (re)connect and
 * applies pushes as they come. Because every payload is the whole list, the
 * newest one wins — so a snapshot that was requested *before* a push arrived
 * is discarded rather than allowed to roll the screen back.
 */
export const createBoardController = (opts: BoardControllerOptions) => {
  let state = initialBoard;
  let connected = false;
  let pushes = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const emit = () => opts.onChange(state, connected);

  const refresh = async () => {
    const seen = pushes;
    try {
      const entries = await opts.fetchSnapshot();
      if (pushes !== seen) return;
      state = replaceBoard(state, entries);
      emit();
    } catch {
      // Keep showing what we have; the next reconnect or poll retries.
    }
  };

  opts.socket.on('board.updated', (entries) => {
    pushes += 1;
    state = replaceBoard(state, entries);
    emit();
  });
  opts.socket.on('connect', () => {
    connected = true;
    emit();
    void refresh();
  });
  opts.socket.on('disconnect', () => {
    connected = false;
    emit();
  });

  return {
    start() {
      opts.socket.connect();
      void refresh();
      if (opts.pollMs)
        timer = setInterval(() => void (!connected && refresh()), opts.pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      opts.socket.disconnect();
    },
  };
};
