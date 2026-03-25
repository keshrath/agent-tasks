export type EventType = 'task:create' | 'task:update' | 'task:delete' | 'pipeline:config';

type Handler = (data: unknown) => void;

class EventBus {
  private listeners = new Map<EventType | '*', Set<Handler>>();

  emit(type: EventType, data?: unknown): void {
    const handlers = this.listeners.get(type);
    if (handlers)
      for (const h of handlers) {
        try {
          h(data);
        } catch {
          /* ignore */
        }
      }
    const wildcards = this.listeners.get('*');
    if (wildcards)
      for (const h of wildcards) {
        try {
          h({ type, data });
        } catch {
          /* ignore */
        }
      }
  }

  on(type: EventType | '*', handler: Handler): () => void {
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
}

export const eventBus = new EventBus();
