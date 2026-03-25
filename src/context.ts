// =============================================================================
// agent-tasks — Application context
//
// Dependency injection root. Creates and wires together all services.
// Every layer receives its dependencies explicitly — no global state.
// =============================================================================

import { createDb, type Db, type DbOptions } from './storage/database.js';
import { EventBus } from './domain/events.js';
import { TaskService } from './domain/tasks.js';
import { CommentService } from './domain/comments.js';
import { CollaboratorService } from './domain/collaborators.js';
import { ApprovalService } from './domain/approvals.js';
import { AgentBridge } from './domain/agent-bridge.js';

export interface AppContext {
  readonly db: Db;
  readonly events: EventBus;
  readonly tasks: TaskService;
  readonly comments: CommentService;
  readonly collaborators: CollaboratorService;
  readonly approvals: ApprovalService;
  readonly agentBridge: AgentBridge;
  close(): void;
}

export function createContext(dbOptions?: DbOptions): AppContext {
  const db = createDb(dbOptions);
  const events = new EventBus();
  let closed = false;

  const tasks = new TaskService(db, events);
  const comments = new CommentService(db, events);
  const collaborators = new CollaboratorService(db, events);
  const approvals = new ApprovalService(db, events);
  const agentBridge = new AgentBridge(events);

  agentBridge.start();

  return {
    db,
    events,
    tasks,
    comments,
    collaborators,
    approvals,
    agentBridge,
    close() {
      if (closed) return;
      closed = true;
      agentBridge.stop();
      events.removeAll();
      db.close();
    },
  };
}
