// =============================================================================
// agent-tasks — Library API
//
// Public exports for programmatic use. Import from 'agent-tasks/lib'.
// The default export (index.ts) is the MCP stdio server.
// =============================================================================

// Context (entry point for library consumers)
export { createContext, type AppContext } from './context.js';

// Storage
export { createDb, type Db, type DbOptions } from './storage/database.js';

// Domain services
export { TaskService } from './domain/tasks.js';
export { CommentService } from './domain/comments.js';
export { CollaboratorService } from './domain/collaborators.js';
export { ApprovalService } from './domain/approvals.js';
export { EventBus } from './domain/events.js';
export { CleanupService } from './domain/cleanup.js';

// Types
export type {
  TaskStatus,
  Task,
  TaskCreateInput,
  TaskUpdateInput,
  TaskListFilter,
  TaskArtifact,
  TaskComment,
  CollaboratorRole,
  TaskCollaborator,
  ApprovalStatus,
  TaskApproval,
  TaskRelationshipType,
  TaskDependency,
  PipelineConfig,
  StageGate,
  GateConfig,
  SearchResult,
  EventType,
  TasksEvent,
  JsonRpcRequest,
  JsonRpcResponse,
  ToolDefinition,
} from './types.js';

// Error classes
export { TasksError, NotFoundError, ConflictError, ValidationError } from './types.js';
