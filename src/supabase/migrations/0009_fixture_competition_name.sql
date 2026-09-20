-- Snapshots the real tournament name from SportsAPI at sync time.
-- competition_id is a foreign key to a single always-Premier-League row: a
-- watched club's cup or other-competition match is also synced under that
-- same id (see shouldWatchMatch), so it can never be trusted as the real
-- competition. The full-time score card divider needs the actual name, not
-- a label that's wrong for anything but a Premier League fixture.

alter table fixtures
  add column competition_name text;
