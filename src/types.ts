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
  /** The session holding the claim (HolderService); null when nothing holds it. */
  readonly holder: string | null;
  /** The stage a completed or cancelled task was closed in: where a reopen puts it. */
  readonly closed_from: string | null;
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
  tags?: string[];
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

export interface TaskLink {
  readonly task: Task;
  readonly relationship: Exclude<TaskRelationshipType, 'blocks'>;
  readonly direction: 'outgoing' | 'incoming';
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  readonly project: string;
  readonly stages: string;
  readonly approval_config: string | null;
  readonly assignment_config: string | null;
  readonly gate_config: string | null;
  readonly updated_at: string;
}

/** What a stage gate still needs before a task may leave `stage`; see TaskService.gateNeeds. */
export interface GateNeeds {
  stage: string;
  comment: boolean;
  /** Any artifact at all in this stage (the project-wide `require_artifact`). */
  artifact: boolean;
  /** Named artifacts still missing in this stage. */
  artifacts: string[];
  /** How many more artifacts this stage needs. */
  min_artifacts: number;
  approval: boolean;
}

export interface StageGate {
  require_artifacts?: string[];
  require_min_artifacts?: number;
  require_comment?: boolean;
  require_approval?: boolean;
}

export interface GateConfig {
  require_comment?: boolean;
  require_artifact?: boolean;
  exempt_stages?: string[];
  gates?: Record<string, StageGate>;
  /**
   * Minimum task confidence score (0–100) required at claim time. Computed
   * by `scoreTaskConfidence` from title + description. Below this threshold,
   * `claim` throws ValidationError. Omit/null to disable.
   */
  min_confidence_for_claim?: number;
  /**
   * Optional per-stage instruction strings surfaced to agents on claim and
   * advance. Keyed by stage name. Lets a project author one-time guidance
   * ("at 'spec' stage, write the acceptance criteria as a checklist") that
   * the harness can show without re-reading CLAUDE.md.
   */
  stage_instructions?: Record<string, string>;
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
  | 'task:reopened'
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
