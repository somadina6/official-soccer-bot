import { startEventConfirmationConsumer } from './event-confirmation.js';
import { startContentGenerationConsumer } from './content-generation.js';
import { startImageGenerationConsumer, startBackgroundPrepScheduler } from './image-generation.js';
import { startXPublishingConsumer } from './x-publishing.js';
import { startPostCorrectionsConsumer } from './post-corrections.js';

/** Starts every queue consumer plus the background-prep scheduler. */
export function startQueueConsumers(): () => void {
  const stops = [
    startEventConfirmationConsumer(),
    startContentGenerationConsumer(),
    startImageGenerationConsumer(),
    startXPublishingConsumer(),
    startPostCorrectionsConsumer(),
    startBackgroundPrepScheduler(),
  ];
  return () => stops.forEach(stop => stop());
}
