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
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TaskDependency {
  readonly task_id: number;
  readonly depends_on: number;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  readonly project: string;
  readonly stages: string;
  readonly updated_at: string;
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
  | 'pipeline:configured';

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
