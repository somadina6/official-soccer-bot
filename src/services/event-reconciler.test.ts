import { describe, expect, it } from 'vitest';
import { shouldSkipDuplicateIngest } from './event-reconciler.js';

const published = {
  revision: 0,
  raw_payload_hash: 'hash-a',
  state: 'PUBLISHED',
};

describe('shouldSkipDuplicateIngest', () => {
  it('skips when any prior revision already has this hash', () => {
    expect(
      shouldSkipDuplicateIngest(
        [
          { revision: 1, raw_payload_hash: 'hash-b', state: 'PUBLISHED' },
          { revision: 0, raw_payload_hash: 'hash-a', state: 'PUBLISHED' },
        ],
        'hash-a',
        'PROVISIONAL',
      ),
    ).toBe(true);
  });

  it('skips a new hash when the incident is already in flight', () => {
    expect(shouldSkipDuplicateIngest([published], 'hash-b', 'PROVISIONAL')).toBe(true);
  });

  it('does not skip the first sighting', () => {
    expect(shouldSkipDuplicateIngest([], 'hash-a', 'PROVISIONAL')).toBe(false);
  });

  it('does not skip an overturn of a published incident', () => {
    expect(shouldSkipDuplicateIngest([published], 'hash-overturned', 'OVERTURNED')).toBe(false);
  });
});
