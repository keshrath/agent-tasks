// =============================================================================
// Scenario C: dep-aware-mgmt — tests the Dependencies feature directly
// =============================================================================
//
// 8 tasks in a "user profile API" feature build with a real DAG. The manager
// is asked dependency-aware questions: who's blocked, on what, what becomes
// claimable when worker-A finishes, what's the critical path, etc.
//
// The dep info lives ONLY in the agent-tasks DB — file system has the source
// files from completed tasks (User type spec, API endpoints spec) but no
// graph. Naive cannot answer dependency questions because the data physically
// does not exist where it can read.

import type { Scenario } from './types.js';

export const depAwareMgmtScenario: Scenario = {
  name: 'dep-aware-mgmt',
  description:
    "8 tasks in a real DAG (user profile API build). Tests the DEPENDENCIES feature: manager questions about who's blocked on whom, what's unblockable now, critical path, etc.",
  project: 'user-profile-api',
  contextHint:
    'You are a MANAGER observing a feature build in progress. The feature is ' +
    '"Add a user profile API" — types, endpoints, tests, docs. There are 8 ' +
    'tasks with dependencies between them (some can only start after others ' +
    'finish). Your job is to answer questions about the dependency structure ' +
    'and what is currently unblocked.',
  tasks: [
    {
      index: 0,
      title: 'Spec the User type',
      description: 'Define the User shape (id, name, email, created_at).',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-A',
      result: 'User type spec finalized',
      artifacts: [
        {
          type: 'general',
          name: 'spec',
          content: `# User type
export interface User {
  id: string;
  name: string;
  email: string;
  created_at: string;
}`,
        },
      ],
    },
    {
      index: 1,
      title: 'Spec the API endpoints',
      description: 'List the REST endpoints, methods, and response shapes.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-A',
      result: 'API endpoints documented',
      artifacts: [
        {
          type: 'general',
          name: 'spec',
          content: `# API endpoints
GET    /user/:id     -> User
PUT    /user/:id     -> User
DELETE /user/:id     -> 204
GET    /users        -> User[]`,
        },
      ],
    },
    {
      index: 2,
      title: 'Implement the User type in src/types.ts',
      description: 'Translate the User spec into TypeScript.',
      stage: 'implement',
      status: 'in_progress',
      claimer: 'worker-B',
      dependsOn: [0],
      artifacts: [
        {
          type: 'comment',
          content: 'Started 4 minutes ago. Working on it.',
        },
      ],
    },
    {
      index: 3,
      title: 'Implement GET /user/:id endpoint',
      description: 'Wire up the GET endpoint using the User type.',
      stage: 'backlog',
      status: 'pending',
      dependsOn: [1, 2],
    },
    {
      index: 4,
      title: 'Implement PUT /user/:id endpoint',
      description: 'Wire up the PUT endpoint using the User type.',
      stage: 'backlog',
      status: 'pending',
      dependsOn: [1, 2],
    },
    {
      index: 5,
      title: 'Implement DELETE /user/:id endpoint',
      description: 'Wire up the DELETE endpoint.',
      stage: 'backlog',
      status: 'pending',
      dependsOn: [1, 2],
    },
    {
      index: 6,
      title: 'Write integration tests for the user endpoints',
      description: 'Cover GET, PUT, DELETE happy paths and error cases.',
      stage: 'backlog',
      status: 'pending',
      dependsOn: [3, 4, 5],
    },
    {
      index: 7,
      title: 'Write API documentation',
      description: 'Write the public API doc page covering all four endpoints.',
      stage: 'backlog',
      status: 'pending',
      dependsOn: [3, 4, 5],
    },
  ],
  files: [
    {
      path: 'package.json',
      content: '{\n  "type": "commonjs",\n  "name": "user-profile-api"\n}\n',
    },
    {
      path: 'README.md',
      content: `# user-profile-api

Adding a user profile API. Currently in flight — multiple agents are
working on different pieces. The dependency structure between the pieces
is tracked by the agent-tasks pipeline (not in this README).
`,
    },
    {
      path: 'src/types.ts.draft',
      content: `// Worker-B WIP — types.ts not yet finished
// User interface incoming...
`,
    },
  ],
  questions: [
    {
      id: 1,
      text: 'Which tasks are CURRENTLY BLOCKED, and on what task(s) are they waiting?',
      mustIncludeAllGroups: [
        [
          'get /user',
          'task 4',
          'task #4',
          'put /user',
          'task 5',
          'task #5',
          'delete',
          'task 6',
          'task #6',
          'integration test',
          'documentation',
          'task 7',
          'task #7',
          'task 8',
          'task #8',
        ],
        ['types.ts', 'task 3', 'task #3', 'user type', 'implement the user'],
      ],
    },
    {
      id: 2,
      text: 'If worker-B (currently on the "Implement the User type" task) finishes RIGHT NOW, which tasks would IMMEDIATELY become claimable by another worker?',
      mustIncludeAllGroups: [
        ['get /user', 'task 4', 'task #4', 'get endpoint'],
        ['put /user', 'task 5', 'task #5', 'put endpoint'],
        ['delete', 'task 6', 'task #6', 'delete endpoint'],
      ],
    },
    {
      id: 3,
      text: 'Could a fresh new worker start "Write integration tests" RIGHT NOW? Why or why not?',
      mustIncludeAllGroups: [
        ['no', 'cannot', "can't", 'not yet', 'blocked'],
        ['endpoint', 'get', 'put', 'delete', 'task 4', 'task 5', 'task 6'],
      ],
    },
    {
      id: 4,
      text: "What's the LONGEST chain of dependencies in this project (the critical path from any starting task to the end)?",
      mustIncludeAllGroups: [
        ['user type', 'types', 'task 1', 'task #1', 'task 3', 'task #3'],
        ['endpoint', 'get', 'put', 'delete', 'task 4', 'task 5', 'task 6'],
        ['test', 'documentation', 'task 7', 'task #7', 'task 8', 'task #8'],
      ],
    },
    {
      id: 5,
      text: 'How many tasks are CURRENTLY UNBLOCKED but UNASSIGNED (could be picked up right now by a fresh worker)?',
      mustIncludeAllGroups: [['0', 'zero', 'none']],
    },
    {
      id: 6,
      text: 'List ALL the tasks that have NO dependencies at all (could have been started first by any worker).',
      mustIncludeAllGroups: [
        ['user type', 'spec the user', 'task 1', 'task #1'],
        ['api endpoint', 'spec the api', 'task 2', 'task #2'],
      ],
    },
    {
      id: 7,
      text: 'How many DOWNSTREAM tasks would be impacted if the "Implement the User type" task FAILED permanently and had to be re-spec\'d?',
      mustIncludeAllGroups: [['5', 'five', '6', 'six']],
    },
    {
      id: 8,
      text: 'If a manager wants to maximize parallelism RIGHT NOW (after worker-B finishes types.ts), how many workers can be productively working in parallel on the next wave of tasks?',
      mustIncludeAllGroups: [['3', 'three']],
    },
    {
      id: 9,
      text: 'What FRACTION of the total task list is CURRENTLY BLOCKED waiting on at least one other task?',
      mustIncludeAllGroups: [
        ['6', 'six', '5', 'five'],
        ['8', 'eight'],
      ],
    },
    {
      id: 10,
      text: 'List EVERY task that depends on "Implement the User type in src/types.ts" (directly or transitively).',
      mustIncludeAllGroups: [
        ['get', 'task 4', 'task #4'],
        ['put', 'task 5', 'task #5'],
        ['delete', 'task 6', 'task #6'],
        ['test', 'integration', 'task 7', 'task #7'],
        ['documentation', 'doc', 'task 8', 'task #8'],
      ],
    },
  ],
};
