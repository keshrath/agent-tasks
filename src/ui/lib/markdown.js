// =============================================================================
// Markdown to DOM, safely: every piece of the source becomes a text node, never
// HTML. Raw HTML in the source shows as the text it is. Covers what task
// descriptions, artifacts and comments use: headings, paragraphs, lists, quotes,
// fenced code, tables, rules, `code`, **bold**, *italic*, ~~strike~~ and links
// (http, https and mailto only; an image shows as its link).
// =============================================================================

import { h } from './dom.js';

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|!?\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Inline Markdown as DOM nodes. */
export function inline(src) {
  const out = [];
  let last = 0;
  for (const m of String(src).matchAll(INLINE)) {
    if (m.index > last) out.push(src.slice(last, m.index));
    if (m[1]) out.push(h('code', null, m[2].trim() || m[2]));
    else if (m[3] || m[4]) out.push(h('strong', null, inline(m[3] ?? m[4])));
    else if (m[5]) out.push(h('del', null, inline(m[5])));
    else if (m[6] || m[7]) out.push(h('em', null, inline(m[6] ?? m[7])));
    else if (m[8]) out.push(link(m[9], inline(m[8])));
    else if (m[10]) out.push(link(m[10], m[10]));
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

function link(href, children) {
  return /^(https?:|mailto:)/i.test(href)
    ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children)
    : h('span', null, children);
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

/** A Markdown document as DOM nodes (block level). */
export function markdown(src) {
  const lines = String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out = [];
  let i = 0;
  const isBlank = (l) => l === undefined || !l.trim();
  const startsBlock = (l) =>
    FENCE.test(l) || HEADING.test(l) || RULE.test(l) || ITEM.test(l) || QUOTE.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(
        h(
          'pre',
          { class: 'md-code' },
          h('code', fence[2] ? { 'data-lang': fence[2] } : null, body.join('\n')),
        ),
      );
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      out.push(h(`h${Math.min(6, heading[1].length + 2)}`, { class: 'md-h' }, inline(heading[2])));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(h('hr'));
      i++;
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i]))
        rows.push(cells(lines[i++]));
      out.push(
        h(
          'div',
          { class: 'md-table' },
          h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                head.map((c) => h('th', null, inline(c))),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((r) =>
                h(
                  'tr',
                  null,
                  head.map((_, j) => h('td', null, inline(r[j] ?? ''))),
                ),
              ),
            ),
          ),
        ),
      );
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
      out.push(h('blockquote', null, markdown(body.join('\n'))));
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      const isOrdered = /\d/.test(item[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(ITEM);
        if (m && m[1].length <= item[1].length) {
          items.push([m[3]]);
          i++;
        } else if (!isBlank(lines[i]) && items.length && /^\s+/.test(lines[i])) {
          items.at(-1).push(lines[i++].replace(/^\s{1,4}/, ''));
        } else break;
      }
      out.push(
        h(
          isOrdered ? 'ol' : 'ul',
          null,
          items.map(([first, ...rest]) => {
            const task = first.match(/^\[([ xX])\]\s+(.*)$/);
            return h(
              'li',
              task ? { class: 'md-task' } : null,
              task
                ? h(
                    'span',
                    { class: 'md-check', 'aria-hidden': 'true' },
                    task[1] === ' ' ? '☐' : '☑',
                  )
                : null,
              inline(task ? task[2] : first),
              rest.length ? markdown(rest.join('\n')) : null,
            );
          }),
        ),
      );
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i])))
      para.push(lines[i++].trim());
    out.push(h('p', null, inline(para.join('\n'))));
  }
  return out;
}
