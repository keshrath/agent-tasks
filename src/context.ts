// =============================================================================
// agent-tasks — Application context
//
// Dependency injection root. Creates and wires together all services.
// Every layer receives its dependencies explicitly — no global state.
// =============================================================================

import { createDb, type Db, type DbOptions } from './storage/database.js';
import { EventBus } from './domain/events.js';
import { TaskService } from './domain/tasks.js';

export interface AppContext {
  readonly db: Db;
  readonly events: EventBus;
  readonly tasks: TaskService;
  close(): void;
}

export function createContext(dbOptions?: DbOptions): AppContext {
  const db = createDb(dbOptions);
  const events = new EventBus();
  let closed = false;

  const tasks = new TaskService(db, events);

  return {
    db,
    events,
    tasks,
    close() {
      if (closed) return;
      closed = true;
      events.removeAll();
      db.close();
    },
  };
}
