// =============================================================================
// agent-tasks — Event bus
//
// Simple in-process pub/sub for domain events.
// =============================================================================

import type { EventType, TasksEvent } from '../types.js';

export type EventHandler = (event: TasksEvent) => void;

export class EventBus {
  private readonly listeners = new Map<EventType | '*', Set<EventHandler>>();

  emit(type: EventType, data: Record<string, unknown> = {}): void {
    const event: TasksEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    const specific = this.listeners.get(type);
    if (specific) {
      for (const h of specific) {
        try {
          h(event);
        } catch (err) {
          process.stderr.write(
            `[agent-tasks] Event handler error (${type}): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }

    const wildcards = this.listeners.get('*');
    if (wildcards) {
      for (const h of wildcards) {
        try {
          h(event);
        } catch (err) {
          process.stderr.write(
            `[agent-tasks] Event handler error (*): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  }

  on(type: EventType | '*', handler: EventHandler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  listenerCount(type?: EventType | '*'): number {
    if (type) {
      return this.listeners.get(type)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
