import { useEffect, useState } from 'react';

/**
 * Returns a debounced copy of `value` that only updates after
 * `delayMs` milliseconds of inactivity.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
