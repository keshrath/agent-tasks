// =============================================================================
// agent-tasks — Event bus
//
// In-process pub/sub over the agent-tasks event vocabulary (../types.ts), with
// wildcard subscribers. A throwing listener is logged and never stops the
// others or the emitter.
// =============================================================================

import type { EventType, TasksEvent } from '../types.js';

type Listener = (event: TasksEvent) => void;

export class EventBus {
  private readonly listeners = new Map<EventType | '*', Set<Listener>>();

  emit(type: EventType, data: Record<string, unknown> = {}): void {
    const event: TasksEvent = { type, timestamp: new Date().toISOString(), data };
    for (const key of [type, '*'] as const) {
      for (const listener of this.listeners.get(key) ?? []) {
        try {
          listener(event);
        } catch (err) {
          process.stderr.write(
            `[agent-tasks] Event listener error (${type}): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  }

  on(type: EventType | '*', listener: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  listenerCount(type?: EventType | '*'): number {
    if (type) return this.listeners.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
