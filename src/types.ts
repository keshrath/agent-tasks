// =============================================================================
// agent-tasks — Core type definitions
// =============================================================================

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly created_by: string;
  readonly assigned_to: string | null;
  readonly status: TaskStatus;
  readonly stage: string;
  readonly priority: number;
  readonly project: string | null;
  readonly tags: string | null;
  readonly result: string | null;
  readonly parent_id: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskCreateInput {
  title: string;
  description?: string;
  assign_to?: string;
  stage?: string;
  priority?: number;
  project?: string;
  tags?: string[];
  parent_id?: number;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  priority?: number;
  project?: string;
  tags?: string[];
  assigned_to?: string;
}

export interface TaskListFilter {
  status?: TaskStatus;
  assigned_to?: string;
  stage?: string;
  project?: string;
  parent_id?: number;
  root_only?: boolean;
  collaborator?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface TaskArtifact {
  readonly id: number;
  readonly task_id: number;
  readonly stage: string;
  readonly name: string;
  readonly content: string;
  readonly created_by: string;
  readonly version: number;
  readonly previous_id: number | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface TaskComment {
  readonly id: number;
  readonly task_id: number;
  readonly agent_id: string;
  readonly content: string;
  readonly parent_comment_id: number | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

export type CollaboratorRole = 'collaborator' | 'reviewer' | 'watcher';

export interface TaskCollaborator {
  readonly task_id: number;
  readonly agent_id: string;
  readonly role: CollaboratorRole;
  readonly added_at: string;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface TaskApproval {
  readonly id: number;
  readonly task_id: number;
  readonly stage: string;
  readonly status: ApprovalStatus;
  readonly reviewer: string | null;
  readonly requested_at: string;
  readonly resolved_at: string | null;
  readonly comment: string | null;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type TaskRelationshipType = 'blocks' | 'related' | 'duplicate';

export interface TaskDependency {
  readonly task_id: number;
  readonly depends_on: number;
  readonly relationship: TaskRelationshipType;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  readonly project: string;
  readonly stages: string;
  readonly approval_config: string | null;
  readonly assignment_config: string | null;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  readonly task: Task;
  readonly snippet: string;
  readonly rank: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventType =
  | 'task:created'
  | 'task:updated'
  | 'task:claimed'
  | 'task:advanced'
  | 'task:regressed'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled'
  | 'task:deleted'
  | 'artifact:created'
  | 'dependency:added'
  | 'dependency:removed'
  | 'pipeline:configured'
  | 'comment:created'
  | 'collaborator:added'
  | 'collaborator:removed'
  | 'approval:requested'
  | 'approval:approved'
  | 'approval:rejected';

export interface TasksEvent {
  readonly type: EventType;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TasksError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'TasksError';
  }
}

export class NotFoundError extends TasksError {
  constructor(entity: string, id: string | number) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends TasksError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends TasksError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 422);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC (MCP transport)
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
