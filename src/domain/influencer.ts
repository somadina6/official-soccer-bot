export type UpcomingFixture = {
  fixtureId: string;
  home: { name: string };
  away: { name: string };
  kickoff: string;
};

export type CompletedMatch = {
  fixtureId: string;
  home: { name: string; score: number };
  away: { name: string; score: number };
  events: string[];
};

export type MatchSummary = {
  fixtureId: string;
  home: { name: string; score?: number };
  away: { name: string; score?: number };
  phase: "half_time" | "full_time";
};

export type StoredPrediction = {
  id: string;
  fixtureId: string;
  prediction: string;
  postId?: string;
};

export type VerifiedResult = {
  home: { name: string; score: number };
  away: { name: string; score: number };
  winner: string;
};
