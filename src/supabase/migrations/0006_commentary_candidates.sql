-- Store all three commentary candidates and rank breakdowns for tone audits.

alter table content_generations
  add column if not exists candidates jsonb,
  add column if not exists rank_debug jsonb;
