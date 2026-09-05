import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_TASKS,
  selectMaintenanceTask,
} from '../apps/jobs/src/index.js';

describe('scheduled maintenance routing', () => {
  it('runs exactly one distinct task in each minute of a complete cycle', () => {
    const cycleStart = Date.UTC(2026, 8, 6, 0, 0);
    const selected = MAINTENANCE_TASKS.map((_, minute) => (
      selectMaintenanceTask(cycleStart + minute * 60_000)
    ));

    expect(new Set(selected)).toEqual(new Set(MAINTENANCE_TASKS));
    expect(selected).toHaveLength(MAINTENANCE_TASKS.length);
  });

  it('repeats the task cycle after seven minutes', () => {
    const scheduledTime = Date.UTC(2026, 8, 6, 0, 0);

    expect(selectMaintenanceTask(
      scheduledTime + MAINTENANCE_TASKS.length * 60_000,
    )).toBe(selectMaintenanceTask(scheduledTime));
  });
});
