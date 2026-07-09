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
    sql: `SELECT n.title AS title, n.slug AS ref, n.type AS meta,
                 snippet(notes_fts, 3, '⟦', '⟧', ' … ', 14) AS excerpt, bm25(notes_fts) AS score
          FROM notes_fts JOIN notes n ON n.slug = notes_fts.slug
          WHERE notes_fts MATCH ? ORDER BY score LIMIT ?`,
  },
  {
    name: 'reading', label: 'scout',
    db: () => env('RECALL_SCOUT_DB') || env('SCOUT_DB') || './.scout/cache.db',
    sql: `SELECT p.title AS title, p.url AS ref, 'web' AS meta,
                 snippet(pages_fts, 2, '⟦', '⟧', ' … ', 14) AS excerpt, bm25(pages_fts) AS score
          FROM pages_fts JOIN pages p ON p.url = pages_fts.url
          WHERE pages_fts MATCH ? ORDER BY score LIMIT ?`,
  },
  {
    name: 'code', label: 'lens',
    db: () => env('RECALL_LENS_DB') || env('LENS_DB') || './.lens/index.db',
    sql: `SELECT path AS title, path || ':' || start AS ref, lang AS meta,
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

// ── federated recall ───────────────────────────────────────────────────────────
export function recall(query, { k = 10, max_tokens = 2000, sources } = {}) {
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

  // Interleave round-robin across stores (bm25 isn't comparable across DBs) so the
  // briefing is balanced, filling to the token budget.
  for (const s in bySource) bySource[s].sort((a, b) => a.score - b.score);
  const order = Object.keys(bySource);
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
  return { query, searched, count: results.length, tokens, results };
}

// ── which stores are available right now ──────────────────────────────────────
export function status() {
  return { stores: STORES.map((s) => {
    const path = s.db();
    const found = existsSync(path);
    let notes = null;
    if (found) { const db = openRO(path); if (db) { try { notes = db.prepare(`SELECT COUNT(*) n FROM ${s.name === 'code' ? 'files' : s.name === 'reading' ? 'pages' : 'notes'}`).get().n; } catch {} db.close(); } }
    return { store: s.name, tool: s.label, db: path, available: found, entries: notes };
  }) };
}
