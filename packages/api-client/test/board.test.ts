import { describe, expect, it } from 'vitest';
import {
  BOARD_LIMIT,
  initialBoard,
  preparingNumbers,
  readyNumbers,
  replaceBoard,
  type BoardEntry,
} from '../src';

const entry = (n: number, status: BoardEntry['status']): BoardEntry => ({
  orderNumber: `A${n}`,
  status,
});

describe('replaceBoard', () => {
  it('replaces the whole list rather than merging', () => {
    let s = replaceBoard(initialBoard, [
      entry(1, 'IN_PREPARATION'),
      entry(2, 'READY'),
    ]);
    s = replaceBoard(s, [entry(3, 'READY')]);
    expect(s.entries).toEqual([entry(3, 'READY')]);
  });

  it('keeps READY orders until the server drops them', () => {
    const s = replaceBoard(initialBoard, [entry(1, 'READY')]);
    expect(readyNumbers(s)).toEqual(['A1']);
    expect(preparingNumbers(s)).toEqual([]);
  });

  it('caps at the limit and says it did', () => {
    const many = Array.from({ length: BOARD_LIMIT + 1 }, (_, i) =>
      entry(i, 'READY'),
    );
    const s = replaceBoard(initialBoard, many);
    expect(s.entries).toHaveLength(BOARD_LIMIT);
    expect(s.truncated).toBe(true);
    expect(
      replaceBoard(initialBoard, many.slice(0, BOARD_LIMIT)).truncated,
    ).toBe(false);
  });

  it('distinguishes an empty board from one not yet loaded', () => {
    expect(initialBoard.loaded).toBe(false);
    expect(replaceBoard(initialBoard, []).loaded).toBe(true);
  });
});
