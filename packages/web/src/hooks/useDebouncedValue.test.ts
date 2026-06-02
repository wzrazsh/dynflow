import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('hello', 300));
    expect(result.current).toBe('hello');
  });

  it('updates after the specified delay', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: 'hello', delay: 300 } },
    );

    // Change value
    rerender({ value: 'world', delay: 300 });

    // Before delay, should still be old value
    expect(result.current).toBe('hello');

    // Fast-forward past delay
    act(() => { vi.advanceTimersByTime(300); });

    // Now it should be updated
    expect(result.current).toBe('world');
  });

  it('resets timer on rapid changes', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: 'a', delay: 300 } },
    );

    // Rapid changes
    rerender({ value: 'ab', delay: 300 });
    act(() => { vi.advanceTimersByTime(100); }); // partially through delay
    rerender({ value: 'abc', delay: 300 });
    act(() => { vi.advanceTimersByTime(100); }); // still before 300ms from 'abc'
    rerender({ value: 'abcd', delay: 300 });

    // Should still be 'a' (timer was reset by each change)
    expect(result.current).toBe('a');

    // Complete the full delay from last change
    act(() => { vi.advanceTimersByTime(300); });

    // Should now be the latest value
    expect(result.current).toBe('abcd');
  });
});
