import { describe, expect, it } from 'vitest';
import { addMinutes, subtractMinutes } from './content-jobs.js';

describe('content job schedule helpers', () => {
  const kickoff = new Date('2026-08-17T15:00:00.000Z');

  it('schedules prediction 45 minutes before kickoff', () => {
    expect(subtractMinutes(kickoff, 45).toISOString()).toBe('2026-08-17T14:15:00.000Z');
  });

  it('schedules the verdict 125 minutes after kickoff', () => {
    expect(addMinutes(kickoff, 125).toISOString()).toBe('2026-08-17T17:05:00.000Z');
  });
});
