// =============================================================================
// agent-tasks — Event bus
//
// Thin extension of agent-common's generic EventBus, parameterized to the
// agent-tasks event vocabulary defined in ../types.ts. The base class provides
// emit/on/removeAll; this subclass adds listenerCount for diagnostics.
// =============================================================================

import { EventBus as KitEventBus } from 'agent-common';
import type { EventType } from '../types.js';

export class EventBus extends KitEventBus<EventType> {
  listenerCount(type?: EventType | '*'): number {
    const listeners = (this as unknown as { listeners: Map<EventType | '*', Set<unknown>> })
      .listeners;
    if (type) {
      return listeners.get(type)?.size ?? 0;
    }
    let total = 0;
    for (const set of listeners.values()) total += set.size;
    return total;
  }
}
