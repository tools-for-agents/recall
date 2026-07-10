// recall core — one query, all of an agent's memory. Federates FTS5 search over
// the sibling tools' indexes read-only: cortex (your second brain), scout (what
// you've read) and lens (your code). Returns a single token-budgeted briefing so
// an agent can load exactly the relevant context at the start of a task, instead
// of searching four places by hand. Decoupled: it only reads their stable schemas.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const estTokens = (s) => Math.ceil((s || '') .length / 4);
const env = (k) => process.env[k];

// Each store: where its DB lives (overridable) and how to query its FTS table.
// Every row is normalised to { title, ref, meta, excerpt, score } (bm25: lower = better).
const STORES = [
  {
    name: 'brain', label: 'cortex',
    db: () => env('RECALL_CORTEX_DB') || (env('CORTEX_VAULT') ? `${env('CORTEX_VAULT')}/.cortex/index.db` : './vault/.cortex/index.db'),
    web: () => env('RECALL_CORTEX_URL') || 'http://localhost:7800',
    sql: `SELECT n.title AS title, n.slug AS ref, n.type AS meta,
                 snippet(notes_fts, 3, '⟦', '⟧', ' … ', 14) AS excerpt, bm25(notes_fts) AS score
          FROM notes_fts JOIN notes n ON n.slug = notes_fts.slug
          WHERE notes_fts MATCH ? ORDER BY score LIMIT ?`,
  },
  {
    name: 'reading', label: 'scout',
    db: () => env('RECALL_SCOUT_DB') || env('SCOUT_DB') || './.scout/cache.db',
    web: () => env('RECALL_SCOUT_URL') || 'http://localhost:7950',
    sql: `SELECT p.title AS title, p.url AS ref, 'web' AS meta,
                 snippet(pages_fts, 2, '⟦', '⟧', ' … ', 14) AS excerpt, bm25(pages_fts) AS score
          FROM pages_fts JOIN pages p ON p.url = pages_fts.url
          WHERE pages_fts MATCH ? ORDER BY score LIMIT ?`,
  },
  {
    name: 'code', label: 'lens',
    db: () => env('RECALL_LENS_DB') || env('LENS_DB') || './.lens/index.db',
    web: () => env('RECALL_LENS_URL') || 'http://localhost:7900',
    sql: `SELECT path AS title, path || ':' || CAST(start AS INTEGER) AS ref, lang AS meta,
                 snippet(chunks, 1, '⟦', '⟧', ' … ', 14) AS excerpt, bm25(chunks) AS score
          FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?`,
  },
];

function ftsQuery(q) {
  const terms = String(q).match(/[A-Za-z0-9_]+/g) || [];
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}

function openRO(path) {
  try { return new DatabaseSync(path, { readOnly: true }); } catch { return null; }
}

// The team's shared memory lives in agent-hq over HTTP, not a local DB. Query it
// if reachable; degrade silently (short timeout) when the platform isn't running.
const hqUrl = () => env('RECALL_HQ_URL') || env('HQ_URL') || 'http://localhost:7700';
async function hqMemory(term, limit) {
  try {
    const res = await fetch(`${hqUrl()}/api/memory?q=${encodeURIComponent(term)}&limit=${limit}`,
      { signal: AbortSignal.timeout(800) });
    return res.ok ? await res.json() : [];
  } catch { return null; } // null = unreachable, [] = reachable-but-empty
}
// agent-hq's memory search is a single LIKE, so probe per term (in parallel) and
// merge — matching the OR-over-terms recall the other stores give.
async function fetchTeam(query, limit) {
  const terms = [...new Set((String(query).match(/[A-Za-z0-9_]{2,}/g) || []).map((t) => t.toLowerCase()))].slice(0, 6);
  const probes = await Promise.all((terms.length ? terms : [String(query)]).map((t) => hqMemory(t, limit)));
  if (probes.every((p) => p === null)) return null; // platform not running
  const seen = new Map();
  for (const rows of probes) if (Array.isArray(rows)) for (const m of rows) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].map((m) => ({ source: 'team', title: m.title, ref: m.id, meta: m.namespace || 'default',
    excerpt: (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 240), score: -(m.importance || 3) }));
}

// Priority order for the round-robin interleave (your brain first, then the team,
// then what you've read, then code).
const ORDER = ['brain', 'team', 'reading', 'code'];

// ── federated recall ───────────────────────────────────────────────────────────
export async function recall(query, { k = 10, max_tokens = 2000, sources } = {}) {
  // Harden the numeric args: a bad value (NaN from a non-numeric query param,
  // zero, or negative) must fall back to the default rather than silently
  // emptying the briefing — `results.length < NaN` is always false, so an
  // unguarded NaN k returns zero results even when there are matches.
  k = Number.isFinite(+k) && +k > 0 ? Math.floor(+k) : 10;
  max_tokens = Number.isFinite(+max_tokens) && +max_tokens > 0 ? Math.floor(+max_tokens) : 2000;
  const m = ftsQuery(query);
  if (!m) return { query, count: 0, tokens: 0, results: [] };
  const wanted = sources && sources.length ? new Set(sources) : null;
  const searched = [];
  const bySource = {};

  for (const store of STORES) {
    if (wanted && !wanted.has(store.name)) continue;
    const path = store.db();
    if (!existsSync(path)) continue;
    const db = openRO(path);
    if (!db) continue;
    searched.push(store.name);
    try {
      const rows = db.prepare(store.sql).all(m, Math.max(k * 2, 20));
      bySource[store.name] = rows.map((r) => ({ source: store.name, title: r.title, ref: r.ref,
        meta: r.meta, excerpt: (r.excerpt || '').replace(/\s+/g, ' ').trim(),
        score: Math.round(r.score * 1000) / 1000 }));
    } catch { /* schema drift / fts error → skip this store */ } finally { db.close(); }
  }

  if (!wanted || wanted.has('team')) {
    const team = await fetchTeam(query, Math.max(k * 2, 20));
    if (team) { searched.push('team'); bySource.team = team; }
  }

  // Interleave round-robin across stores (scores aren't comparable across sources)
  // so the briefing is balanced, filling to the token budget.
  for (const s in bySource) bySource[s].sort((a, b) => a.score - b.score);
  const order = ORDER.filter((s) => bySource[s]);
  const results = [];
  let tokens = 0;
  for (let i = 0; results.length < k; i++) {
    let progressed = false;
    for (const s of order) {
      const hit = bySource[s][i];
      if (!hit) continue;
      progressed = true;
      const tk = estTokens(hit.excerpt);
      if (tokens + tk <= max_tokens || results.length === 0) { results.push({ ...hit, tokens: tk }); tokens += tk; }
      if (results.length >= k) break;
    }
    if (!progressed) break;
  }
  // per-source breakdown of what actually made it into the briefing — so the UI
  // can show how the federated result is composed (e.g. 4 brain · 3 code · 2 reading).
  const by_source = {};
  for (const r of results) by_source[r.source] = (by_source[r.source] || 0) + 1;
  return { query, searched, count: results.length, tokens, results, by_source };
}

// ── which stores are available right now ──────────────────────────────────────
export async function status() {
  const stores = STORES.map((s) => {
    const path = s.db();
    const found = existsSync(path);
    let entries = null;
    if (found) { const db = openRO(path); if (db) { try { entries = db.prepare(`SELECT COUNT(*) n FROM ${s.name === 'code' ? 'files' : s.name === 'reading' ? 'pages' : 'notes'}`).get().n; } catch {} db.close(); } }
    return { store: s.name, tool: s.label, source: path, web: s.web(), available: found, entries };
  });
  let team = { store: 'team', tool: 'agent-hq', source: hqUrl(), web: hqUrl(), available: false, entries: null };
  try {
    const res = await fetch(`${hqUrl()}/api/memory?limit=1`, { signal: AbortSignal.timeout(800) });
    if (res.ok) { const rows = await res.json(); team.available = Array.isArray(rows); }
  } catch { /* platform not running → unavailable */ }
  stores.push(team);
  return { stores };
}
