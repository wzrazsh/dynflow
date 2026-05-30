import { describe, it, expect } from 'vitest';
import { ConcurrencyLimiter } from '../../src/runtime/ConcurrencyLimiter.js';

describe('ConcurrencyLimiter', () => {
  it('should limit concurrent executions', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, () =>
      limiter.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(resolve => setTimeout(resolve, 50));
        running--;
        return true;
      })
    );

    await Promise.all(tasks);

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('should execute all tasks', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const results: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, i) =>
      limiter.run(async () => {
        results.push(i);
        return i;
      })
    );

    await Promise.all(tasks);

    expect(results).toHaveLength(10);
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('should track active and queued counts', async () => {
    const limiter = new ConcurrencyLimiter(2);

    expect(limiter.activeCount).toBe(0);
    expect(limiter.queuedCount).toBe(0);

    const p1 = limiter.run(async () => {
      expect(limiter.activeCount).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    const p2 = limiter.run(async () => {
      expect(limiter.activeCount).toBe(2);
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    // Third task should queue
    const p3 = limiter.run(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    await Promise.all([p1, p2, p3]);

    expect(limiter.activeCount).toBe(0);
    expect(limiter.queuedCount).toBe(0);
  });
});
