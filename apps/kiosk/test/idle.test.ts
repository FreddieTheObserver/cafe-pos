import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleTimer } from '../src/idle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createIdleTimer', () => {
  it('fires once after the idle time', () => {
    const onIdle = vi.fn();
    createIdleTimer(1000, onIdle).reset();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('is pushed back by activity', () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer(1000, onIdle);
    timer.reset();
    vi.advanceTimersByTime(800);
    timer.reset();
    vi.advanceTimersByTime(800);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('does not fire once stopped', () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer(1000, onIdle);
    timer.reset();
    timer.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
