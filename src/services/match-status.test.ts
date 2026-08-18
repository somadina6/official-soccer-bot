import { describe, expect, it } from 'vitest';
import { isMatchFinished, matchStatusFromPayload } from './match-status.js';

describe('isMatchFinished', () => {
  it('treats a finished fixture or a full-time event as done', () => {
    expect(isMatchFinished('finished', false)).toBe(true);
    expect(isMatchFinished('live', true)).toBe(true);
    expect(isMatchFinished('live', false)).toBe(false);
    expect(isMatchFinished('scheduled', false)).toBe(false);
  });
});

describe('matchStatusFromPayload', () => {
  it('reads finished, live and postponed provider statuses', () => {
    expect(matchStatusFromPayload({ event: { status: { type: 'finished' } } })).toBe('finished');
    expect(matchStatusFromPayload({ event: { status: { type: 'inprogress' } } })).toBe('live');
    expect(matchStatusFromPayload({ data: { status: { type: 'postponed' } } })).toBe('postponed');
    expect(matchStatusFromPayload({ status: 'notstarted' })).toBe('scheduled');
  });
});
