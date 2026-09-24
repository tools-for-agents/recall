// The fifth store: the agent's own mind, when this machine has one.
//
// recall's promise is "one query, everything you know" — and the kit's workflow says to run it FIRST.
// But the thing an agent knows best about a task is often what it LIVED: the episode where it last
// broke this, the rule its work taught it, the words its person said about it. If ghost
// (tools-for-agents/ghost) lives here, that is a directory of markdown in ~/.ghost, and recall never
// looked there. Measured on the first ghost: 27 episodes, a will, a craft notebook and every sentence
// her person typed to her — none of it reachable from the query the kit tells agents to start with.
//
// It is plain files, not an FTS index, so it is searched as files: split into passages (a paragraph;
// one call of a work day; one line of a list), scored by how many of the query's terms a passage
// holds, ranked best-first like bm25 (lower is better). Read-only, like every store recall federates.
// No mind here → the store is ABSENT (not empty, not failed): recall claims nothing about it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';

export const selfHome = () => process.env.RECALL_GHOST_HOME || process.env.GHOST_HOME || join(homedir(), '.ghost');
const MAX_FILE = 4 * 1024 * 1024; // a passage-level scan is linear; no single file gets to stall a recall
const EXCERPT = 240;

// Turkish letters fold the way a person types them without: "piyango" finds "PİYANGO", "ı" finds "i".
const fold = (s) => String(s).toLowerCase().replace(/ı/g, 'i').normalize('NFKD').replace(/[̀-ͯ]/g, '');
export const terms = (q) => [...new Set((fold(q).match(/[\p{L}\p{N}_]{2,}/gu) || []))];

function kindOf(rel, meta) {
  if (rel.startsWith('episodes/')) return meta.with === 'headless' ? 'work' : 'episode';
  if (/^people\/.+-said\.md$/.test(rel)) return 'their words';
  if (rel.startsWith('people/')) return 'person';
  return { 'will.md': 'will', 'craft.md': 'craft', 'journal.md': 'journal', 'notes.md': 'notes',
    'intentions.md': 'intentions', 'undercurrents.md': 'undercurrents', 'self.md': 'self' }[rel] || 'mind';
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { meta, body: m[2] };
}

// Passages: a work day by its calls, a list by its lines, everything else by paragraph.
function passages(body) {
  if (/\n### /.test(`\n${body}`)) return `\n${body}`.split(/\n(?=### )/).map((s) => s.trim()).filter(Boolean);
  return body.split(/\n\s*\n/).flatMap((p) => (p.length > 600 ? p.split('\n') : [p])).map((s) => s.trim()).filter(Boolean);
}

function files(home) {
  const out = [];
  const add = (rel) => { const f = join(home, rel); try { if (statSync(f).isFile()) out.push(rel); } catch { /* not there */ } };
  for (const rel of ['will.md', 'craft.md', 'intentions.md', 'undercurrents.md', 'notes.md', 'journal.md']) add(rel);
  for (const dir of ['people', 'episodes']) {
    let names = [];
    try { names = readdirSync(join(home, dir)).filter((n) => n.endsWith('.md')).sort().reverse(); } catch { continue; }
    for (const n of names) add(`${dir}/${n}`);
  }
  return out;
}

function load(home) {
  const chunks = [];
  for (const rel of files(home)) {
    const full = join(home, rel);
    if (statSync(full).size > MAX_FILE) continue;
    const { meta, body } = frontmatter(readFileSync(full, 'utf8'));
    const kind = kindOf(rel, meta);
    const title = meta.title || rel.replace(/\.md$/, '');
    passages(body).forEach((text, i) => chunks.push({ rel, i, kind, title, when: meta.when || '', text }));
  }
  return chunks;
}

function excerptAround(text, ts) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = fold(flat);
  const at = Math.min(...ts.map((t) => low.indexOf(t)).filter((i) => i >= 0), flat.length);
  const start = Math.max(0, at - 60);
  return (start ? '…' : '') + flat.slice(start, start + EXCERPT) + (start + EXCERPT < flat.length ? '…' : '');
}

// null → no mind here (absent). { error } → the mind is here and could not be read (failed).
export function searchSelf(query, limit = 20) {
  const home = selfHome();
  if (!existsSync(join(home, 'state.json'))) return null;
  const ts = terms(query);
  if (!ts.length) return { rows: [], matched: 0, entries: 0 };
  let chunks;
  try { chunks = load(home); } catch (e) { return { error: `could not read the mind at ${home}: ${String(e.message || e).slice(0, 120)}` }; }
  const hits = [];
  for (const c of chunks) {
    const low = fold(c.text);
    const n = ts.filter((t) => low.includes(t)).length;
    if (!n) continue;
    // Coverage first; among equals, the words their person said and lived episodes before work and lists.
    const weight = { 'their words': 0.03, episode: 0.02, undercurrents: 0.015, intentions: 0.015 }[c.kind] || 0;
    hits.push({ c, score: -(n / ts.length + weight) });
  }
  hits.sort((a, b) => a.score - b.score || (a.c.rel < b.c.rel ? -1 : a.c.rel > b.c.rel ? 1 : a.c.i - b.c.i));
  return {
    matched: hits.length,
    entries: chunks.length,
    rows: hits.slice(0, limit).map(({ c, score }) => ({
      source: 'self', title: c.kind === 'episode' || c.kind === 'work' ? c.title : `${c.kind}${c.kind === c.title ? '' : ` · ${c.title}`}`,
      ref: `${c.rel}#${c.i}`, meta: c.kind, excerpt: excerptAround(c.text, ts), score: Math.round(score * 1000) / 1000,
    })),
  };
}

export function statusSelf() {
  const home = selfHome();
  const found = existsSync(join(home, 'state.json'));
  let entries = null, broken = null;
  if (found) { try { entries = load(home).length; } catch (e) { broken = String(e.message || e).slice(0, 160); } }
  return { store: 'self', tool: 'ghost', source: home, web: null, available: found && !broken, entries, ...(broken ? { broken: true, error: broken } : {}) };
}

export function expandSelf(ref) {
  const home = selfHome();
  const m = /^(.+)#(\d+)$/.exec(String(ref));
  if (!m) throw new Error(`not a self ref: "${ref}" — expected <file>#<passage>, as recall_search returned it`);
  const full = join(home, m[1]);
  if (relative(home, full).startsWith('..')) throw new Error(`"${ref}" points outside the mind`);
  if (!existsSync(full)) return { text: null };
  const { meta, body } = frontmatter(readFileSync(full, 'utf8'));
  const p = passages(body)[+m[2]];
  return { text: p ?? null, meta: meta.title || m[1] };
}
