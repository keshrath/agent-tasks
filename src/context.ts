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
import { CleanupService } from './domain/cleanup.js';

export interface AppContext {
  readonly db: Db;
  readonly events: EventBus;
  readonly tasks: TaskService;
  readonly comments: CommentService;
  readonly collaborators: CollaboratorService;
  readonly approvals: ApprovalService;
  readonly agentBridge: AgentBridge;
  readonly cleanup: CleanupService;
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
  const retentionDays = parseInt(process.env.AGENT_TASKS_RETENTION_DAYS ?? '30', 10);
  const cleanup = new CleanupService(db, retentionDays, agentBridge);

  agentBridge.start();
  cleanup.start();

  return {
    db,
    events,
    tasks,
    comments,
    collaborators,
    approvals,
    agentBridge,
    cleanup,
    close() {
      if (closed) return;
      closed = true;
      cleanup.stop();
      agentBridge.stop();
      events.removeAll();
      db.close();
    },
  };
}
