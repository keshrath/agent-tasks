import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/domain/events.js';
import type { TasksEvent } from '../src/types.js';

describe('EventBus', () => {
  it('emits events to specific listeners', () => {
    const bus = new EventBus();
    const received: TasksEvent[] = [];
    bus.on('task:created', (e) => received.push(e));

    bus.emit('task:created', { id: 1 });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('task:created');
    expect(received[0].data.id).toBe(1);
  });

  it('does not emit to unrelated listeners', () => {
    const bus = new EventBus();
    const received: TasksEvent[] = [];
    bus.on('task:deleted', (e) => received.push(e));

    bus.emit('task:created', { id: 1 });

    expect(received).toHaveLength(0);
  });

  it('wildcard listener receives all events', () => {
    const bus = new EventBus();
    const received: TasksEvent[] = [];
    bus.on('*', (e) => received.push(e));

    bus.emit('task:created', { id: 1 });
    bus.emit('task:deleted', { id: 2 });

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('task:created');
    expect(received[1].type).toBe('task:deleted');
  });

  it('unsubscribe removes listener', () => {
    const bus = new EventBus();
    const received: TasksEvent[] = [];
    const unsub = bus.on('task:created', (e) => received.push(e));

    bus.emit('task:created', { id: 1 });
    unsub();
    bus.emit('task:created', { id: 2 });

    expect(received).toHaveLength(1);
  });

  it('removeAll clears all listeners', () => {
    const bus = new EventBus();
    bus.on('task:created', () => {});
    bus.on('*', () => {});

    expect(bus.listenerCount()).toBe(2);

    bus.removeAll();

    expect(bus.listenerCount()).toBe(0);
  });

  it('listenerCount returns count for specific type', () => {
    const bus = new EventBus();
    bus.on('task:created', () => {});
    bus.on('task:created', () => {});
    bus.on('task:deleted', () => {});

    expect(bus.listenerCount('task:created')).toBe(2);
    expect(bus.listenerCount('task:deleted')).toBe(1);
    expect(bus.listenerCount('task:updated')).toBe(0);
  });

  it('includes timestamp in emitted events', () => {
    const bus = new EventBus();
    let event: TasksEvent | null = null;
    bus.on('task:created', (e) => (event = e));

    bus.emit('task:created');

    expect(event).not.toBeNull();
    expect(event!.timestamp).toBeDefined();
    expect(new Date(event!.timestamp).getTime()).not.toBeNaN();
  });

  it('survives handler errors without stopping other handlers', () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.on('task:created', () => {
      throw new Error('handler crash');
    });
    bus.on('task:created', () => received.push('second'));

    bus.emit('task:created');

    expect(received).toEqual(['second']);
  });

  it('multiple listeners on same event all fire', () => {
    const bus = new EventBus();
    const calls: number[] = [];
    bus.on('task:created', () => calls.push(1));
    bus.on('task:created', () => calls.push(2));
    bus.on('task:created', () => calls.push(3));

    bus.emit('task:created');

    expect(calls).toEqual([1, 2, 3]);
  });
});
