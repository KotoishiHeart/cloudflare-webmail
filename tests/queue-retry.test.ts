import { describe, expect, it } from 'vitest';
import {
  isD1DailyLimitError,
  queueRetryDelay,
} from '../apps/jobs/src/queue-retry.js';

describe('Queue retry policy', () => {
  it('delays D1 daily quota failures until just after the next UTC reset', () => {
    const now = Date.UTC(2026, 6, 16, 13, 0, 0);
    const error = new Error(
      "D1_ERROR: Your account has exceeded the free plan limit for D1 rows written",
    );
    expect(isD1DailyLimitError(error)).toBe(true);
    expect(queueRetryDelay(error, 1, now)).toBe(11 * 60 * 60 + 60);
  });

  it('recognizes a nested daily quota error without treating storage limits as resettable', () => {
    const daily = new Error('query failed', {
      cause: new Error('D1 daily rows read quota limit exceeded'),
    });
    expect(isD1DailyLimitError(daily)).toBe(true);
    expect(isD1DailyLimitError(
      new Error("D1_ERROR: Your account has exceeded D1's maximum account storage limit"),
    )).toBe(false);
  });

  it('keeps bounded exponential backoff for other transient errors', () => {
    const error = new Error('D1 DB is overloaded. Too many requests queued.');
    expect(queueRetryDelay(error, 1, 0)).toBe(30);
    expect(queueRetryDelay(error, 3, 0)).toBe(120);
    expect(queueRetryDelay(error, 50, 0)).toBe(3600);
  });

  it('never exceeds the Cloudflare Queue 24 hour delay bound', () => {
    const error = new Error('D1 daily limit exceeded');
    expect(queueRetryDelay(error, 1, Date.UTC(2026, 6, 16))).toBe(24 * 60 * 60);
  });
});
