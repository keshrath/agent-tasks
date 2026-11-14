export type AgentTasksStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** One task as a board row draws it: GET /api/board's task plus its subtasks and blockers. */
export type AgentTasksTask = {
  id: number;
  title: string;
  stage: string;
  status: AgentTasksStatus;
  priority: number;
  project: string | null;
  assigned_to: string | null;
  tags: string[];
  parent_id: number | null;
  /** The result (completed), the error (failed) or the reason (cancelled). */
  result: string | null;
  updated_at: string;
  /** Open tasks this one waits for (a `blocks` dependency that is not finished). */
  blocked_by: number[];
  subtasks: { done: number; total: number } | null;
};

/** What the REST server looked like at the last poll. `isUp` false: only `old` is meaningful. */
export type AgentTasksSnapshot = {
  isUp: boolean;
  /** REST origin, e.g. http://127.0.0.1:3422 */
  origin: string;
  /** Down because an agent-tasks without the board (1.x) holds the port: its version. */
  old: string | null;
  /** The default pipeline. */
  stages: string[];
  /** Projects of open tasks whose pipeline differs from the default. */
  pipelines: Record<string, string[]>;
  /** Every pending and in-progress task. */
  open: AgentTasksTask[];
  /** The most recently finished tasks, newest first. */
  recent: AgentTasksTask[];
  /** Who the person is when they act from the pane (task creator, comment author, `by`). */
  me: string;
};

export type AgentTasksTab = 'board' | 'done' | 'new';

/**
 * Which view the pane shows; `task` set is that task's detail, opened from `tab`.
 * `trail` holds the tasks walked through (a blocker, a subtask) for the way back.
 */
export type AgentTasksRoute = { tab: AgentTasksTab; task: number | null; trail: number[] };

export type AgentTasksRef = {
  id: number;
  title: string;
  stage: string;
  status: AgentTasksStatus;
  /** It waits for an open task, as the board's `!` mark says. */
  isBlocked: boolean;
};

/** What the stage gate still needs before the task leaves its stage: the server's `gate_needs`. */
export type AgentTasksGate = {
  comment: boolean;
  /** Any artifact at all in this stage. */
  artifact: boolean;
  /** Named artifacts still missing in this stage. */
  artifacts: string[];
  /** How many more artifacts this stage needs. */
  more: number;
  approval: boolean;
};

/** One task's detail view (GET /api/tasks/:id with subtasks and comments). */
export type AgentTasksDetail = {
  id: number;
  title: string;
  description: string;
  stage: string;
  status: AgentTasksStatus;
  priority: number;
  project: string | null;
  assigned_to: string | null;
  tags: string[];
  result: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  parent: AgentTasksRef | null;
  /** The pipeline of its project. */
  stages: string[];
  blockers: AgentTasksRef[];
  blocking: AgentTasksRef[];
  /** Null when nothing holds it in its stage, or when it is closed. */
  gate: AgentTasksGate | null;
  /** Tasks linked without blocking (`related`, `duplicate`), either way round. */
  links: (AgentTasksRef & { relationship: string })[];
  subtasks: AgentTasksRef[];
  /** Below it, all levels: the open subtasks a delete is refused for, the finished it takes along. */
  subtree: { open: number[]; finished: number };
  artifacts: {
    id: number;
    stage: string;
    name: string;
    version: number;
    created_by: string;
    created_at: string;
    /** Cut to what the pane draws; `cut` says how much was left out. */
    content: string;
    cut: number;
  }[];
  /** Every comment the task has; `comments` holds the newest of them. */
  commentCount: number;
  comments: { id: number; author: string; content: string; created_at: string }[];
};

/** An action that needs words first: its field is drawn in the detail. */
export type AgentTasksForm = {
  action: 'regress' | 'complete' | 'fail' | 'cancel';
  task: number;
  /** The stage a regression goes back to. */
  stage: string | null;
  /**
   * The words typed so far, for the form's button (Enter in the field submits its own). The
   * field keeps its text itself: drawn back from here, a redraw behind fast typing loses keys.
   */
  words: string;
  /**
   * Words the field draws once: a refused submit cleared the field (Enter does), and these put
   * the submitted words back. Unchanged while the person types, so no redraw fights the keys.
   */
  seed?: string;
  /** How often the field was drawn anew with `seed` (its key carries it: `formKey`). */
  drawn?: number;
  /** The task's stage when the form opened: changed elsewhere since, the form closes. */
  at: string;
  /** Send back: the stage was picked (the ring then goes on to Why). */
  picked?: boolean;
};

/** The order the board and Done were drawn in (task ids), each its own. */
export type AgentTasksPinned = { board: number[]; done: number[] };

/** The New tab's fields as typed. */
export type AgentTasksDraft = {
  title: string;
  project: string;
  priority: string;
  tags: string;
  description: string;
};

declare module 'claude-code' {
  interface PluginState {
    'agent-tasks': {
      snapshot: AgentTasksSnapshot | null;
      route: AgentTasksRoute;
      /** The text the board is narrowed to (Find, `/pipeline <text>`); '' shows all. */
      filter: string;
      detail: AgentTasksDetail | null;
      /** Unfolded parts of the detail: `desc`, `art:<id>`, `comments` (`foldKey` in view.tsx). */
      expanded: string[];
      /** An action waiting for a second press ("delete:12"). */
      confirm: string | null;
      form: AgentTasksForm | null;
      draft: AgentTasksDraft;
      /**
       * Bumped whenever a text field is submitted. A field clears itself on Enter and is
       * drawn from state again only under a new key, which this makes.
       */
      rev: number;
      /**
       * Bumped to have a landing wait for the drawing of what was just written: Refresh carries
       * it in its key, which only that drawing has (no field is re-keyed by it).
       */
      frame: number;
      /** The action in flight ("advance #12"), shown instead of its outcome. */
      busy: string | null;
      /** The last action's outcome, one line. */
      notice: string | null;
      /** The key of the pane's element holding the ring; null when none does. */
      focused: string | null;
      /**
       * The order the board and Done were drawn in when the pane took the keyboard (task ids);
       * kept while it holds it, so a poll never moves rows under the ring. Null: sorted afresh.
       */
      pinned: AgentTasksPinned | null;
      /** The open tasks this session holds (its claims), marked on the board and in a task. */
      mine: number[];
    };
  }
}
