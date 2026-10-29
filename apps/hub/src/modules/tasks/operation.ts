import type { MessagingService, PostInput } from '../../contracts';

interface QueuedPost {
  build: () => PostInput;
  noteForCaller?: string;
}

/**
 * Everything one task operation (an RPC call and every transition it triggers)
 * says, collected and sent in order at the end, still inside the transaction.
 *
 * Deferring lets a transition's summary be posted *before* its effects' messages
 * while still knowing who those effects notified (they are skipped in the
 * summary), and lets threads close only after the last message is posted.
 *
 * No echoes: nothing posted in the thread of the task the call acted on reaches
 * the agent whose call started it, hub steps that call triggered included. Its
 * RPC result shows the outcome, and a consequence it must still learn goes in
 * `notes`, for that result. Notices about other tasks (a dependent now ready or
 * assigned to it) are new work and reach it as usual.
 */
export class Operation {
  /**
   * The agent whose RPC call started the operation, or null when no agent waits
   * on its result (a human through the bridge, the hub, another module calling in).
   */
  readonly rootActorId: string | null;
  /** The thread of the task the call acts on; set once that task is known. */
  rootThreadId: number | null = null;
  /** One-line notes for the caller's RPC result. */
  readonly notes: string[] = [];
  readonly #messaging: MessagingService;
  readonly #isExternalThread: (threadId: number) => boolean;
  readonly #posts: QueuedPost[] = [];
  readonly #closes: Array<{ threadId: number; by: string }> = [];

  constructor(
    messaging: MessagingService,
    rootActorId: string | null,
    isExternalThread: (threadId: number) => boolean,
  ) {
    this.#messaging = messaging;
    this.rootActorId = rootActorId;
    this.#isExternalThread = isExternalThread;
  }

  /**
   * Queues a message; a function is evaluated at flush time (for late recipient
   * lists). `noteForCaller` replaces the delivery when the caller is dropped from it.
   */
  post(input: PostInput | (() => PostInput), opts: { noteForCaller?: string } = {}): void {
    this.#posts.push({ build: typeof input === 'function' ? input : () => input, ...opts });
  }

  closeThread(threadId: number, by: string): void {
    if (!this.#closes.some((c) => c.threadId === threadId)) this.#closes.push({ threadId, by });
  }

  /**
   * Posts in order. Every post in an external task's thread is `external`: they
   * quote its title (and more), whichever effect or summary wrote them.
   */
  flush(): void {
    for (const { build, noteForCaller } of this.#posts.splice(0)) {
      const input = this.#withoutEcho(build(), noteForCaller);
      const external = this.#isExternalThread(input.threadId);
      this.#messaging.post(external ? { ...input, trust: 'external' } : input);
    }
    for (const { threadId, by } of this.#closes.splice(0))
      this.#messaging.closeThread(threadId, by);
  }

  /** A root-thread post minus the caller; still stored (history, feed) if nobody is left. */
  #withoutEcho(input: PostInput, noteForCaller: string | undefined): PostInput {
    const caller = this.rootActorId;
    if (caller === null || input.senderId === caller) return input;
    if (input.threadId !== this.rootThreadId) return input;
    const to =
      input.to ??
      this.#messaging.participants(input.threadId).filter((id) => id !== input.senderId);
    if (!to.includes(caller)) return input;
    if (noteForCaller) this.notes.push(noteForCaller);
    return { ...input, to: to.filter((id) => id !== caller) };
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
