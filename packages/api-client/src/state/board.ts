import type { BoardEntry } from '../types';

/** The board never renders more than this; matches the KDS snapshot cap. */
export const BOARD_LIMIT = 200;

export interface BoardState {
  entries: BoardEntry[];
  /** More orders exist than fit, so the screen can say so rather than silently cut. */
  truncated: boolean;
  /** False until a snapshot or event arrives, so the screen can tell "empty" from "not loaded". */
  loaded: boolean;
}

export const initialBoard: BoardState = {
  entries: [],
  truncated: false,
  loaded: false,
};

/**
 * `board.updated` and `GET /orders/board` both carry the whole list, so applying
 * either is a replacement. There is nothing to merge and nothing to get out of order:
 * the latest one received is the truth.
 */
export const replaceBoard = (
  _state: BoardState,
  entries: readonly BoardEntry[],
): BoardState => ({
  entries: entries.slice(0, BOARD_LIMIT),
  truncated: entries.length > BOARD_LIMIT,
  loaded: true,
});

export const readyNumbers = (state: BoardState): string[] =>
  state.entries.filter((e) => e.status === 'READY').map((e) => e.orderNumber);

export const preparingNumbers = (state: BoardState): string[] =>
  state.entries
    .filter((e) => e.status === 'IN_PREPARATION')
    .map((e) => e.orderNumber);
