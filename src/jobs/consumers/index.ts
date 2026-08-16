import { startEventConfirmationConsumer } from './event-confirmation.js';
import { startContentGenerationConsumer } from './content-generation.js';
import { startImageGenerationConsumer } from './image-generation.js';
import { startXPublishingConsumer } from './x-publishing.js';
import { startPostCorrectionsConsumer } from './post-corrections.js';

/** Starts every queue consumer. */
export function startQueueConsumers(): () => void {
  const stops = [
    startEventConfirmationConsumer(),
    startContentGenerationConsumer(),
    startImageGenerationConsumer(),
    startXPublishingConsumer(),
    startPostCorrectionsConsumer(),
  ];
  return () => stops.forEach(stop => stop());
}
