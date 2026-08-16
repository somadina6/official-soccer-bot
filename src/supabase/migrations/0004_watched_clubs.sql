-- Clubs whose matches in any competition are added to the fixture allow-list
-- (in addition to every Premier League match). Seed expectations only; the
-- SportsAPI team id is discovered at boot, same as competitions.

create table if not exists watched_clubs (
  id bigint generated always as identity primary key,
  slug text not null unique,
  provider text not null,
  provider_team_id bigint,
  expected_name text not null,
  expected_country text not null,
  verified_at timestamptz
);

alter table watched_clubs enable row level security;

-- Example (uncomment and run once, then restart the worker with SportsAPI on):
insert into watched_clubs (slug, provider, expected_name, expected_country)
values ('arsenal', 'sportsapi-pro', 'Arsenal', 'England'),
('man-city', 'sportsapi-pro', 'Manchester City', 'England');
('liverpool', 'sportsapi-pro', 'Liverpool', 'England'),
('chelsea', 'sportsapi-pro', 'Chelsea', 'England'),
('tottenham', 'sportsapi-pro', 'Tottenham Hotspur', 'England'),
('manchester-united', 'sportsapi-pro', 'Manchester United', 'England');