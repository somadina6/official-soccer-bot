-- Image prompts now live in versioned application code (image-flow/prompt-builder).
-- content_generations no longer stores a model-generated prompt.

alter table content_generations
  alter column image_prompt drop not null;
