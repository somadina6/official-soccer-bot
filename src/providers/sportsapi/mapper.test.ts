import { describe, expect, it } from 'vitest';
import { buildIdempotencyKey } from '../../domain/match-event.js';
import {
  canonicalTournamentId,
  extractApprovedIncidentFacts,
  extractIncidents,
  extractLiveMatches,
  extractMatchDetails,
  extractScheduledMatches,
  matchInvolvesTeam,
  normalizeIncident,
  shouldWatchMatch,
  teamIdFromUnknown,
  type MatchContext,
  type ScheduledMatch,
} from './mapper.js';

const context: MatchContext = {
  matchId: '14109842',
  competitionId: '1',
  home: { id: '1', name: 'Arsenal', score: 1, colours: ['#EF0107'] },
  away: { id: '2', name: 'Chelsea', score: 1, colours: ['#034694'] },
};

describe('normalizeIncident', () => {
  it('normalizes a live-shaped goal with assist1 and clock minute', () => {
    const event = normalizeIncident(
      {
        id: 357835369,
        incidentType: 'goal',
        incidentClass: 'regular',
        time: 85,
        isHome: true,
        player: { id: 790864, name: 'Levente Szabó' },
        assist1: { id: 190911, name: 'Josip Ćorluka' },
        homeScore: 2,
        awayScore: 1,
      },
      context,
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('GOAL');
    expect(event!.status).toBe('PROVISIONAL');
    expect(event!.minute).toBe(85);
    expect(event!.home.score).toBe(2);
    expect(event!.player).toEqual({ id: '790864', name: 'Levente Szabó' });
    expect(event!.assist).toEqual({ id: '190911', name: 'Josip Ćorluka' });
    expect(event!.incidentId).toBe('357835369');
  });

  it('maps ownGoal class and red cards; ignores yellows and substitutions', () => {
    expect(
      normalizeIncident({ id: 1, incidentType: 'goal', incidentClass: 'ownGoal', time: 40 }, context)
        ?.type,
    ).toBe('OWN_GOAL');
    expect(
      normalizeIncident({ id: 2, incidentType: 'card', incidentClass: 'red', time: 88 }, context)?.type,
    ).toBe('RED_CARD');
    expect(
      normalizeIncident({ id: 3, incidentType: 'card', incidentClass: 'yellowRed', time: 70 }, context)
        ?.type,
    ).toBe('RED_CARD');
    expect(
      normalizeIncident({ id: 4, incidentType: 'card', incidentClass: 'yellow', time: 24 }, context),
    ).toBeNull();
    expect(
      normalizeIncident({ id: 5, incidentType: 'substitution', incidentClass: 'regular', time: 60 }, context),
    ).toBeNull();
  });

  it('treats period FT as full time and ignores first-half period markers', () => {
    const ft = normalizeIncident(
      { text: 'FT', incidentType: 'period', time: 90, addedTime: 999, homeScore: 2, awayScore: 1 },
      context,
    );
    expect(ft?.type).toBe('FULL_TIME');
    expect(ft?.minute).toBe(90);
    expect(ft?.stoppageMinute).toBeUndefined();

    expect(
      normalizeIncident({ text: 'First half', incidentType: 'period', time: 45, addedTime: 999 }, context),
    ).toBeNull();
  });

  it('marks rescinded incidents as OVERTURNED', () => {
    const event = normalizeIncident(
      { id: 555, incidentType: 'goal', incidentClass: 'regular', time: 67, rescinded: true },
      context,
    );
    expect(event!.status).toBe('OVERTURNED');
  });

  it('maps varDecision and keeps a recorded addedTime', () => {
    const event = normalizeIncident(
      { id: 9, incidentType: 'varDecision', time: 90, addedTime: 4 },
      context,
    );
    expect(event?.type).toBe('VAR');
    expect(event?.stoppageMinute).toBe(4);
  });

  it('produces a stable hash for identical payloads', () => {
    const payload = { id: 555, incidentType: 'goal', incidentClass: 'regular', time: 67 };
    const a = normalizeIncident(payload, context);
    const b = normalizeIncident({ ...payload }, context);
    expect(a!.rawPayloadHash).toBe(b!.rawPayloadHash);
  });

  it('ignores volatile passing-network fields in the hash', () => {
    const base = {
      id: 357951136,
      incidentType: 'goal',
      incidentClass: 'regular',
      time: 48,
      isHome: true,
      player: { id: 547410, name: 'Martin Ødegaard' },
      assist1: { id: 1031259, name: 'Christos Tzolis' },
      homeScore: 3,
      awayScore: 0,
    };
    const a = normalizeIncident(
      { ...base, footballPassingNetworkAction: [{ eventType: 'pass', playerCoordinates: { x: 1, y: 2 } }] },
      context,
    );
    const b = normalizeIncident(
      { ...base, footballPassingNetworkAction: [{ eventType: 'pass', playerCoordinates: { x: 9, y: 8 } }], userCount: 99 },
      context,
    );
    expect(a!.rawPayloadHash).toBe(b!.rawPayloadHash);

    const overturned = normalizeIncident({ ...base, rescinded: true }, context);
    expect(overturned!.rawPayloadHash).not.toBe(a!.rawPayloadHash);
  });
});

describe('buildIdempotencyKey', () => {
  it('uses the provider incident ID when available', () => {
    const event = normalizeIncident(
      { id: 555, incidentType: 'goal', incidentClass: 'regular', time: 67 },
      context,
    )!;
    expect(buildIdempotencyKey(event, 0)).toBe('sportsapi-pro:14109842:555:0');
  });

  it('falls back to minute/type/player when there is no incident ID', () => {
    const event = normalizeIncident(
      {
        incidentType: 'card',
        incidentClass: 'red',
        time: 88,
        player: { id: 4, name: 'Someone' },
      },
      context,
    )!;
    expect(buildIdempotencyKey(event, 1)).toBe('sportsapi-pro:14109842:88:RED_CARD:4:1');
  });
});

describe('extractScheduledMatches', () => {
  it('extracts the flat events list and skips malformed rows', () => {
    const payload = {
      success: true,
      events: [
        {
          id: 16363633,
          startTimestamp: 1787338800,
          tournament: { id: 1, uniqueTournament: { id: 17, name: 'Premier League' } },
          homeTeam: { id: 42, name: 'Arsenal' },
          awayTeam: { id: 11, name: 'Coventry City' },
        },
        { bogus: true },
      ],
      tournaments: 50,
    };
    const matches = extractScheduledMatches(payload);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe(16363633);
    expect(canonicalTournamentId(matches[0]!)).toBe(17);
  });

  it('returns an empty list for unrecognized payloads', () => {
    expect(extractScheduledMatches({ unexpected: true })).toEqual([]);
    expect(extractScheduledMatches({ data: { tournaments: [] } })).toEqual([]);
    expect(extractScheduledMatches(null)).toEqual([]);
  });
});

describe('extractLiveMatches', () => {
  it('reads nested data.events from /live/all', () => {
    const payload = {
      success: true,
      data: {
        events: [
          {
            id: 16248427,
            startTimestamp: 1786888800,
            tournament: { id: 1307, uniqueTournament: { id: 346, name: 'Community Shield' } },
            homeTeam: { id: 42, name: 'Arsenal' },
            awayTeam: { id: 17, name: 'Manchester City' },
          },
        ],
      },
    };
    const matches = extractLiveMatches(payload);
    expect(matches).toHaveLength(1);
    expect(canonicalTournamentId(matches[0]!)).toBe(346);
  });

  it('ignores the simplified /live list that has string team names', () => {
    expect(
      extractLiveMatches({
        success: true,
        events: [
          {
            id: 16248427,
            homeTeam: 'Arsenal',
            awayTeam: 'Manchester City',
            tournament: 'Community Shield',
            startTimestamp: 1786888800,
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe('extractMatchDetails', () => {
  it('unwraps data.event and top-level match from /match/{id}', () => {
    const event = {
      id: 16248427,
      startTimestamp: 1786888800,
      tournament: { id: 1307, uniqueTournament: { id: 346 } },
      homeTeam: { id: 42, name: 'Arsenal' },
      awayTeam: { id: 17, name: 'Manchester City' },
    };
    expect(extractMatchDetails({ success: true, data: { event } })?.id).toBe(16248427);
    expect(extractMatchDetails({ success: true, match: event })?.id).toBe(16248427);
    expect(extractMatchDetails({ data: {} })).toBeUndefined();
  });
});

describe('extractIncidents', () => {
  it('reads REST data.incidents and a bare incidents array', () => {
    const goal = { id: 1, incidentType: 'goal', time: 12 };
    expect(extractIncidents({ data: { incidents: [goal], home: {}, away: {} } })).toEqual([goal]);
    expect(extractIncidents({ incidents: [goal] })).toEqual([goal]);
    expect(extractIncidents([goal])).toEqual([goal]);
    expect(extractIncidents({})).toEqual([]);
  });
});

describe('extractApprovedIncidentFacts', () => {
  it('whitelists qualitative goal details and drops numbers', () => {
    const facts = extractApprovedIncidentFacts({
      id: 357944908,
      time: 1,
      isHome: true,
      incidentType: 'goal',
      incidentClass: 'regular',
      player: { id: 957602, name: 'Riccardo Calafiori', position: 'D', jerseyNumber: '33' },
      assist1: { id: 1423711, name: 'Myles Lewis-Skelly' },
      homeScore: 1,
      awayScore: 0,
      footballPassingNetworkAction: [
        {
          eventType: 'pass',
          player: { id: 1031259, name: 'Christos Tzolis' },
          playerCoordinates: { x: 79.6, y: 85 },
        },
        {
          eventType: 'goal',
          bodyPart: 'left-foot',
          situation: 'assisted',
          goalMouthLocation: 'low-left',
          goalkeeper: { name: 'Gianluigi Donnarumma' },
        },
      ],
    });
    expect(facts).toEqual([
      'scored by the home team',
      'from open play',
      'player is a defender',
      'left foot',
      'low left',
      'assisted',
      'goalkeeper Gianluigi Donnarumma',
    ]);
    expect(facts.join(' ')).not.toMatch(/\d/);
    expect(facts.join()).not.toContain('Tzolis');
  });

  it('labels a saved penalty distinctly from a miss', () => {
    expect(
      extractApprovedIncidentFacts({
        incidentType: 'penaltySaved',
        time: 78,
        player: { id: 1, name: 'Haaland' },
      }),
    ).toContain('penalty saved');
    expect(
      extractApprovedIncidentFacts({
        incidentType: 'penaltyMissed',
        time: 78,
        player: { id: 1, name: 'Haaland' },
      }),
    ).toContain('penalty missed');
  });

  it('includes a digit-free card reason and skips empty payloads', () => {
    expect(
      extractApprovedIncidentFacts({
        incidentType: 'card',
        incidentClass: 'red',
        isHome: false,
        reason: 'Off the ball foul',
        player: { id: 1, name: 'Someone', position: 'M' },
      }),
    ).toEqual(['player is a midfielder', 'off the ball foul']);
    expect(extractApprovedIncidentFacts({ seeded: true })).toEqual([]);
    expect(extractApprovedIncidentFacts(null)).toEqual([]);
  });
});

describe('shouldWatchMatch', () => {
  const premierLeagueId = 17;
  const arsenalId = 42;
  const plMatch: ScheduledMatch = {
    id: 1,
    startTimestamp: 1765800000,
    tournament: { id: 1, uniqueTournament: { id: premierLeagueId } },
    homeTeam: { id: 99, name: 'Brighton' },
    awayTeam: { id: 100, name: 'Everton' },
  };
  const communityShield: ScheduledMatch = {
    id: 2,
    startTimestamp: 1765800000,
    tournament: { id: 1307, uniqueTournament: { id: 346 } },
    homeTeam: { id: arsenalId, name: 'Arsenal' },
    awayTeam: { id: 7, name: 'Crystal Palace' },
  };

  it('reads numeric and string team ids', () => {
    expect(teamIdFromUnknown({ id: 42 })).toBe(42);
    expect(teamIdFromUnknown({ id: '42' })).toBe(42);
    expect(teamIdFromUnknown({ name: 'Arsenal' })).toBeUndefined();
  });

  it('uses uniqueTournament.id, not the per-season tournament.id', () => {
    expect(canonicalTournamentId(plMatch)).toBe(17);
    expect(canonicalTournamentId(communityShield)).toBe(346);
    expect(shouldWatchMatch(plMatch, premierLeagueId, new Set())).toBe(true);
    expect(shouldWatchMatch(communityShield, premierLeagueId, new Set())).toBe(false);
  });

  it('adds non-PL matches that involve a watched club', () => {
    const watched = new Set([arsenalId]);
    expect(shouldWatchMatch(communityShield, premierLeagueId, watched)).toBe(true);
    expect(matchInvolvesTeam(communityShield, watched)).toBe(true);
    expect(shouldWatchMatch(plMatch, premierLeagueId, watched)).toBe(true);
  });
});
