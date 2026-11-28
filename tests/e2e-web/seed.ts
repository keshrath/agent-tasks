// =============================================================================
// A believable board for the dashboard e2e and its screenshots: tasks in every
// stage, some claimed, one blocked, subtasks, a custom-pipeline project,
// artifacts, comments, and finished work spread over the last week.
// Written straight into a scratch SQLite file through the built library.
// =============================================================================

process.env.AGENT_COMM_URL = 'http://127.0.0.1:1';
process.env.AGENT_KNOWLEDGE_URL = 'http://127.0.0.1:1';
const { createContext } = await import('../../dist/context.js');

export interface Seeded {
  /** In progress in implement, claimed by alice: every stage action applies. */
  working: number;
  /** Waits for `working` (a blocks dependency). */
  blocked: number;
  /** Pending, unclaimed, in backlog. */
  unclaimed: number;
  /** Completed. */
  finished: number;
  /** Parent with two subtasks. */
  parent: number;
}

const DAY = 86_400_000;
const at = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);

export function seed(path: string): Seeded {
  const ctx = createContext({ path });
  const t = ctx.tasks;
  const make = (
    title: string,
    o: {
      project?: string;
      priority?: number;
      tags?: string[];
      description?: string;
      parent_id?: number;
    } = {},
  ) => t.create({ title, ...o }, 'mathias').id;
  const claim = (id: number, who: string, to?: string) => {
    t.claim(id, who);
    if (to && t.getById(id)!.stage !== to) t.advance(id, to);
    return id;
  };

  const working = claim(
    make('Rate-limit the public search endpoint', {
      project: 'api',
      priority: 5,
      tags: ['backend', 'security'],
      description: [
        'Search is open to the world and a single client can saturate it.',
        '',
        '## Acceptance',
        '- [x] 429 with `Retry-After` past **60 req/min** per key',
        '- [ ] limits configurable per tenant',
        '- [ ] dashboard shows throttled requests',
        '',
        'See [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) and <script>alert(1)</script> stays text.',
        'Prior art: [Foo (bar)](https://en.wikipedia.org/wiki/Foo_(bar)); [the alert link](javascript:alert(1)) stays text.',
      ].join('\n'),
    }),
    'alice',
    'implement',
  );
  t.addArtifact(
    working,
    'plan',
    [
      '1. Token bucket in Redis, keyed by API key',
      '2. Middleware before the router',
      '',
      '| limit | window | burst |',
      '| --- | --- | --- |',
      '| 60 | 1 min | 10 |',
      '',
      '```ts',
      "app.use(rateLimit({ window: '1m', max: 60 }));",
      '```',
    ].join('\n'),
    'alice',
    'plan',
  );
  ctx.comments.add(working, 'bob', 'Do we keep the old **unlimited** keys for internal tools?');
  ctx.comments.add(working, 'alice', 'Yes, behind an allow-list. Added to the plan.');

  const blocked = claim(
    make('Expose throttling metrics on /metrics', {
      project: 'api',
      priority: 3,
      tags: ['observability'],
    }),
    'bob',
    'spec',
  );
  t.addDependency(blocked, working, 'blocks');

  const parent = claim(
    make('Onboarding flow redesign', { project: 'web', priority: 4, tags: ['ux'] }),
    'carol',
    'plan',
  );
  const sub1 = make('Wireframes for the three steps', { parent_id: parent });
  make('Copy review with marketing', { parent_id: parent });
  claim(sub1, 'carol', 'review');

  claim(make('Migrate CI to the new runners', { project: 'infra', tags: ['ci'] }), 'dave', 'test');
  claim(
    make('Dark mode for the settings page', {
      project: 'web',
      priority: 2,
      tags: ['ux', 'frontend'],
    }),
    'erin',
    'implement',
  );
  make('Investigate flaky upload test', { project: 'api', priority: 1, tags: ['tests'] });
  make('Write the 3.2 release notes', { project: 'docs' });
  const unclaimed = make('Evaluate SQLite FTS5 trigram tokenizer', {
    project: 'api',
    tags: ['search', 'spike'],
  });
  claim(
    make('Audit npm dependencies', { project: 'infra', priority: 2, tags: ['security'] }),
    'dave',
    'review',
  );

  const finished = claim(
    make('Fix timezone bug in the digest mail', { project: 'api', tags: ['bug'] }),
    'bob',
    'review',
  );
  t.complete(finished, 'Digest uses the recipient timezone; regression test added.');
  const shipped: [string, string, 'complete' | 'fail' | 'cancel', number][] = [
    ['Upgrade Node to 22 LTS', 'infra', 'complete', 1],
    ['Cache avatars at the edge', 'web', 'complete', 1],
    ['Remove the legacy v1 export', 'api', 'complete', 2],
    ['Try Bun for the test runner', 'infra', 'fail', 2],
    ['Translate the pricing page', 'web', 'complete', 3],
    ['Add CSV import', 'api', 'complete', 4],
    ['Old billing provider webhook', 'api', 'cancel', 0],
    ['Accessibility pass on forms', 'web', 'complete', 5],
    ['Nightly backup check', 'infra', 'complete', 6],
  ];
  for (const [title, project, outcome, daysAgo] of shipped) {
    const id = claim(make(title, { project }), 'alice', 'review');
    if (outcome === 'complete') t.complete(id, 'Shipped.');
    else if (outcome === 'fail') t.fail(id, 'Two suites hang under Bun; staying on Node.');
    else t.cancel(id, 'The provider was dropped.');
    ctx.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [at(daysAgo * DAY + 3_600_000), id]);
  }
  ctx.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [at(2 * 3_600_000), unclaimed]);
  ctx.close();
  return { working, blocked, unclaimed, finished, parent };
}
