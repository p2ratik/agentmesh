import type { JetStreamClient } from '@nats-io/jetstream';

export interface PublishResult {
  duplicate: boolean;
  seq: number;
}

/**
 * Publishes JSON to a JetStream subject. `msgId` enables server-side dedup
 * inside the stream's duplicate window, so retries are safe.
 */
export async function publishJson(
  js: JetStreamClient,
  subject: string,
  data: unknown,
  msgId?: string,
): Promise<PublishResult> {
  const ack = await js.publish(subject, JSON.stringify(data), msgId ? { msgID: msgId } : undefined);
  return { duplicate: ack.duplicate, seq: ack.seq };
}
