import { z } from 'zod';

export const GeneratedContentSchema = z.object({
  postText: z.string(),
  imagePrompt: z.string(),
  altText: z.string(),
  referencedFacts: z.array(z.string()),
  risk: z.enum(['low', 'review', 'reject']),
});

export type GeneratedContent = z.infer<typeof GeneratedContentSchema>;

export type BanterTone = 'neutral' | 'playful' | 'spicy';
