export interface Task {
  id: number;
  title: string;
  description: string | null;
  created_by: string;
  assigned_to: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  priority: number;
  project: string | null;
  tags: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskArtifact {
  id: number;
  task_id: number;
  stage: string;
  name: string;
  content: string;
  created_by: string;
  created_at: string;
}

export interface TaskDependency {
  task_id: number;
  depends_on: number;
}

export interface PipelineConfig {
  project: string;
  stages: string;
  updated_at: string;
}

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
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
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
