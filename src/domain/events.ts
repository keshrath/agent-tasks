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
        } catch {
          /* fail-safe */
        }
      }
    }

    const wildcards = this.listeners.get('*');
    if (wildcards) {
      for (const h of wildcards) {
        try {
          h(event);
        } catch {
          /* fail-safe */
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

  removeAll(): void {
    this.listeners.clear();
  }
}
