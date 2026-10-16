import type { MessagingService, PostInput } from '../../contracts';

/**
 * Everything one task operation (an RPC call and every transition it triggers)
 * says, collected and sent in order at the end, still inside the transaction.
 *
 * Deferring lets a transition's summary be posted *before* its effects' messages
 * while still knowing who those effects notified (they are skipped in the
 * summary), and lets threads close only after the last message is posted.
 */
export class Operation {
  /** The participant whose call started the operation; they get the RPC result. */
  readonly rootActorId: string;
  readonly #messaging: MessagingService;
  readonly #posts: Array<() => PostInput> = [];
  readonly #closes: Array<{ threadId: number; by: string }> = [];

  constructor(messaging: MessagingService, rootActorId: string) {
    this.#messaging = messaging;
    this.rootActorId = rootActorId;
  }

  /** Queues a message; a function is evaluated at flush time (for late recipient lists). */
  post(input: PostInput | (() => PostInput)): void {
    this.#posts.push(typeof input === 'function' ? input : () => input);
  }

  closeThread(threadId: number, by: string): void {
    if (!this.#closes.some((c) => c.threadId === threadId)) this.#closes.push({ threadId, by });
  }

  flush(): void {
    for (const build of this.#posts.splice(0)) this.#messaging.post(build());
    for (const { threadId, by } of this.#closes.splice(0))
      this.#messaging.closeThread(threadId, by);
  }
}

/** Records who one transition's effect messages reach inside the task's own thread. */
export class NotifyScope {
  readonly threadId: number;
  readonly notified = new Set<string>();

  constructor(threadId: number) {
    this.threadId = threadId;
  }

  record(input: PostInput): void {
    if (input.threadId !== this.threadId) return;
    for (const id of input.to ?? []) this.notified.add(id);
  }
}
