// =============================================================================
// The /pipeline pane on the desktop app's native surface, and its widget glance.
// Docked: a header (tabs, Refresh, New task), a filter bar (Find, project and
// assignee pickers), stat tiles and two Svg charts (open tasks per stage, tasks
// finished per day), then the board as kanban columns of cards (`Kanban`, view.tsx)
// with the open task's detail in a panel beside it. Minimized to a widget:
// the counts per stage, the share in progress, and this session's tasks. Same state
// and actions as the terminal pane (view.tsx); only the layout differs.
// =============================================================================
import type { AgentTasksSnapshot } from '../types';
import {
  ANY,
  Kanban,
  ACCENT,
  BAD,
  Detail,
  Done,
  Down,
  NewTask,
  OK,
  WARN,
  af,
  clip,
  color,
  headline,
  noticeTone,
  refreshKey,
  stageOrder,
  tally,
  titleOf,
  type El,
  type PaneProps,
} from './view';

/** Columns the detail beside the board is laid out for: its texts clip and wrap to this. */
const PANEL_COLS = 64;
/** From this many columns the detail sits beside the board; narrower, it takes the pane. */
const WIDE = 110;
const DAYS = 7;

/** Chart colours that read on a light and a dark backdrop alike (an Svg draws as an image). */
const INK = '#8b919a';
const WORKING = '#3d82f6';
const WAITING = '#a8c3f5';
const FAILED = '#e5534b';
const DONE = '#3fa66b';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Open tasks per stage as horizontal bars, in progress solid and waiting light. */
export function stageChart(snap: AgentTasksSnapshot): { source: string; alt: string } {
  const stages = stageOrder(snap).filter(
    (s) => s !== 'done' || snap.open.some((t) => t.stage === s),
  );
  const rows = stages.map((s) => {
    const here = snap.open.filter((t) => t.stage === s);
    const working = here.filter((t) => t.status === 'in_progress').length;
    return { stage: s, working, waiting: here.length - working };
  });
  const most = Math.max(1, ...rows.map((r) => r.working + r.waiting));
  const W = 360;
  const LABEL = 84;
  const ROW = 20;
  const bar = (n: number) => ((W - LABEL - 34) * n) / most;
  const body = rows
    .map((r, i) => {
      const y = 22 + i * ROW;
      const total = r.working + r.waiting;
      return [
        `<text x="${LABEL - 8}" y="${y + 11}" text-anchor="end" fill="${INK}">${esc(clip(r.stage, 12))}</text>`,
        r.working
          ? `<rect x="${LABEL}" y="${y}" width="${bar(r.working)}" height="14" rx="3" fill="${WORKING}"/>`
          : '',
        r.waiting
          ? `<rect x="${LABEL + bar(r.working)}" y="${y}" width="${bar(r.waiting)}" height="14" rx="3" fill="${WAITING}"/>`
          : '',
        `<text x="${LABEL + bar(total) + 6}" y="${y + 11}" fill="${INK}">${total}</text>`,
      ].join('');
    })
    .join('');
  const H = 22 + rows.length * ROW + 4;
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="11">` +
    `<text x="0" y="12" fill="${INK}" font-weight="600">Open by stage</text>` +
    `<rect x="${W - 150}" y="3" width="9" height="9" rx="2" fill="${WORKING}"/><text x="${W - 137}" y="12" fill="${INK}">in progress</text>` +
    `<rect x="${W - 70}" y="3" width="9" height="9" rx="2" fill="${WAITING}"/><text x="${W - 57}" y="12" fill="${INK}">waiting</text>` +
    body +
    '</svg>';
  const alt = `Open tasks by stage: ${rows.map((r) => `${r.stage} ${r.working + r.waiting} (${r.working} in progress)`).join(', ')}`;
  return { source, alt };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Tasks finished on each of the last DAYS days (of the recent ones the board holds), per outcome. */
export function throughputChart(
  snap: AgentTasksSnapshot,
  now = new Date(),
): { source: string; alt: string; total: number } {
  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(now.getTime() - (DAYS - 1 - i) * 86_400_000);
    return { key: day(d), label: d.toLocaleDateString('en', { weekday: 'short' }) };
  });
  const counts = days.map(({ key }) => {
    const on = snap.recent.filter((t) => t.updated_at.slice(0, 10) === key);
    return {
      done: on.filter((t) => t.status === 'completed').length,
      failed: on.filter((t) => t.status !== 'completed').length,
    };
  });
  const most = Math.max(1, ...counts.map((c) => c.done + c.failed));
  const W = 260;
  const TOP = 32;
  const PLOT = 76;
  const step = W / DAYS;
  const h = (n: number) => (PLOT * n) / most;
  const body = counts
    .map((c, i) => {
      const x = i * step + step * 0.2;
      const w = step * 0.6;
      const base = TOP + PLOT;
      return [
        c.done
          ? `<rect x="${x}" y="${base - h(c.done)}" width="${w}" height="${h(c.done)}" rx="2" fill="${DONE}"/>`
          : '',
        c.failed
          ? `<rect x="${x}" y="${base - h(c.done) - h(c.failed)}" width="${w}" height="${h(c.failed)}" rx="2" fill="${FAILED}"/>`
          : '',
        `<text x="${x + w / 2}" y="${base + 14}" text-anchor="middle" fill="${INK}">${days[i]!.label}</text>`,
        c.done + c.failed
          ? `<text x="${x + w / 2}" y="${base - h(c.done + c.failed) - 3}" text-anchor="middle" fill="${INK}">${c.done + c.failed}</text>`
          : '',
      ].join('');
    })
    .join('');
  const H = TOP + PLOT + 20;
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="11">` +
    `<text x="0" y="12" fill="${INK}" font-weight="600">Finished, last ${DAYS} days</text>` +
    `<line x1="0" y1="${TOP + PLOT}" x2="${W}" y2="${TOP + PLOT}" stroke="${INK}" stroke-opacity="0.4"/>` +
    body +
    '</svg>';
  const alt = `Tasks finished per day, last ${DAYS} days: ${days.map((d, i) => `${d.label} ${counts[i]!.done} completed, ${counts[i]!.failed} failed or cancelled`).join('; ')}`;
  const total = counts.reduce((n, c) => n + c.done + c.failed, 0);
  return { source, alt, total };
}

/** One figure in a tile: a big number over its name. */
function Tile({ el, n, label, tone }: { el: El; n: number; label: string; tone?: string }) {
  const { Box, Text } = el;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      paddingX={2}
      paddingY="xs"
      minWidth={14}
    >
      <Text bold {...color(n > 0 && tone)}>
        {String(n)}
      </Text>
      <Text dimColor>{label}</Text>
    </Box>
  );
}

/** The filter bar: Find and the project and assignee pickers, as the web dashboard had. */
function Filters({ p }: { p: PaneProps }) {
  const { Box, Input, Select } = p.el;
  const { snap, on } = p;
  const isBoard = p.route.tab === 'board';
  const all = [...snap.open, ...snap.recent];
  const projects = [...new Set(all.map((t) => t.project).filter((x): x is string => !!x))].sort();
  const agents = [...new Set(all.map((t) => t.assigned_to ?? 'unclaimed'))].sort();
  return (
    <Box columnGap="sm" rowGap="xs" flexWrap="wrap" alignItems="center">
      {Input && (
        <Input
          key={`find:${p.rev}`}
          placeholder="Find: id, title, agent, project or tag"
          value={p.filter}
          submitLabel="find"
          onInput={on.typing}
          onSubmit={on.find}
        />
      )}
      {Select && isBoard && projects.length > 1 && (
        <Select
          key="facet:project"
          value={p.facets.project || ANY}
          options={[
            { value: ANY, label: 'All projects' },
            ...projects.map((v) => ({ value: v, label: v })),
          ]}
          onSelect={(v) => on.facet('project', v === ANY ? '' : v)}
        />
      )}
      {Select && isBoard && agents.length > 1 && (
        <Select
          key="facet:assignee"
          value={p.facets.assignee || ANY}
          options={[
            { value: ANY, label: 'All assignees' },
            ...agents.map((v) => ({ value: v, label: v })),
          ]}
          onSelect={(v) => on.facet('assignee', v === ANY ? '' : v)}
        />
      )}
    </Box>
  );
}

const TABS = [
  ['board', 'Board'],
  ['done', 'Done'],
] as const;

/** The docked pane on the desktop app. */
export function DesktopPane(p: PaneProps) {
  const { Box, Text, Button, Svg } = p.el;
  const { snap, route, on } = p;
  const n = tally(snap.open);
  const failed = snap.recent.filter((t) => t.status === 'failed').length;

  let main;
  if (!snap.isUp) main = <Down el={p.el} snap={snap} />;
  else if (route.tab === 'board') main = <Kanban p={p} />;
  else if (route.tab === 'done')
    main = (
      <Done
        el={p.el}
        on={on}
        auto={p.landing}
        snap={snap}
        width={Math.min(96, p.columns)}
        filter={p.filter}
        pinned={p.pinned?.done ?? null}
      />
    );
  else
    main = (
      <NewTask
        el={p.el}
        on={on}
        auto={p.landing}
        draft={p.draft}
        snap={snap}
        rev={p.rev}
        width={Math.min(90, p.columns)}
      />
    );

  const isWide = p.columns >= WIDE;
  const panelCols = isWide ? Math.min(PANEL_COLS, Math.floor(p.columns * 0.42)) : p.columns - 4;
  const panel =
    snap.isUp && route.task !== null ? (
      p.detail?.id === route.task ? (
        <Detail
          el={p.el}
          on={on}
          auto={p.landing}
          d={p.detail}
          route={route}
          expanded={p.expanded}
          confirm={p.confirm}
          form={p.form}
          rev={p.rev}
          width={panelCols}
          isMine={p.mine.includes(p.detail.id)}
          backTitle={titleOf(snap, route.trail.at(-1))}
          isPanel
        />
      ) : (
        <p.el.Progress label={`#${route.task}`} valueText="loading…" />
      )
    ) : null;

  const stage = snap.isUp && snap.open.length > 0 ? stageChart(snap) : null;
  const flow = snap.isUp ? throughputChart(snap) : null;
  const isAlone = panel !== null && !isWide;

  return (
    <Box flexDirection="column" gap="md" padding="sm">
      <Box justifyContent="space-between" alignItems="center" flexWrap="wrap" rowGap="xs">
        <Box columnGap="sm" alignItems="center">
          <Text bold>Pipeline</Text>
          {TABS.map(([tab, label]) => (
            <Button
              key={`tab:${tab}`}
              {...af(p.landing, `tab:${tab}`)}
              label={label}
              {...(route.tab === tab ? { variant: 'primary' as const } : {})}
              onPress={() => on.go(tab)}
            />
          ))}
        </Box>
        <Box columnGap="sm" alignItems="center">
          <Button
            key={refreshKey(snap.isUp, p.frame)}
            label="Refresh"
            {...af(p.landing, refreshKey(snap.isUp, p.frame))}
            onPress={on.refresh}
          />
          <Button
            key="tab:new"
            {...af(p.landing, 'tab:new')}
            label="New task"
            {...(route.tab === 'new' ? {} : { variant: 'primary' as const })}
            onPress={() => on.go('new')}
          />
        </Box>
      </Box>

      {snap.isUp && route.tab !== 'new' && !isAlone && <Filters p={p} />}

      {p.busy ? (
        <p.el.Progress label={p.busy} valueText="…" color={WARN} />
      ) : p.notice ? (
        <Text {...noticeTone(p.notice)} wrap="wrap">
          {p.notice}
        </Text>
      ) : null}

      {snap.isUp && route.tab === 'board' && !isAlone && (
        <Box columnGap="md" rowGap="sm" flexWrap="wrap" alignItems="flex-start">
          <Box columnGap="sm" flexWrap="wrap" rowGap="sm">
            <Tile el={p.el} n={n.open} label="open" />
            <Tile el={p.el} n={n.working} label="in progress" tone={OK} />
            <Tile el={p.el} n={n.blocked} label="blocked" tone={WARN} />
            <Tile el={p.el} n={failed} label="failed lately" tone={BAD} />
          </Box>
          {Svg && stage && <Svg source={stage.source} alt={stage.alt} />}
          {Svg && flow && flow.total > 0 && <Svg source={flow.source} alt={flow.alt} />}
        </Box>
      )}

      <Box columnGap="md" alignItems="flex-start">
        {!isAlone && (
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={30}>
            {main}
          </Box>
        )}
        {panel && (
          <Box
            flexDirection="column"
            {...(isWide ? { width: panelCols + 4, flexShrink: 0 } : { flexGrow: 1 })}
            borderStyle="round"
            borderDimColor
            padding="sm"
          >
            {panel}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** The minimized pane on the desktop app: a glance, no controls (a press may not reach it). */
export function Glance({ el, snap, mine }: Pick<PaneProps, 'el' | 'snap' | 'mine'>) {
  const { Box, Text, Progress } = el;
  if (!snap.isUp)
    return (
      <Box flexDirection="column" padding="xs">
        <Text bold>Pipeline</Text>
        <Text color={BAD}>The agent-tasks server is not reachable.</Text>
      </Box>
    );
  const n = tally(snap.open);
  const counts = stageOrder(snap)
    .map((s) => [s, snap.open.filter((t) => t.stage === s).length] as const)
    .filter(([, c]) => c > 0);
  const own = snap.open.filter((t) => mine.includes(t.id));
  return (
    <Box flexDirection="column" gap="xs" padding="xs">
      <Text bold>Pipeline</Text>
      <Progress
        label={headline(snap.open)}
        value={n.working}
        max={Math.max(1, n.open)}
        valueText={`${n.working}/${n.open} in progress`}
        color={OK}
      />
      {counts.length === 0 ? (
        <Text dimColor>Nothing open.</Text>
      ) : (
        <Text dimColor wrap="wrap">
          {counts.map(([s, c]) => `${s} ${c}`).join(' · ')}
        </Text>
      )}
      {own.length > 0 && (
        <Box flexDirection="column">
          <Text color={ACCENT}>This session</Text>
          {own.map((t) => (
            <Text key={`mine:${t.id}`} wrap="truncate">
              <Text dimColor>#{t.id} </Text>
              {t.title}
              <Text dimColor> · {t.stage}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
