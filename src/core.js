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
    // How many this store ACTUALLY has — not how many fit the candidate window,
    // and certainly not how many survived the budget. See `stores` in recall().
    count_sql: `SELECT COUNT(*) n FROM notes_fts WHERE notes_fts MATCH ?`,
  },
  {
    name: 'reading', label: 'scout',
    db: () => env('RECALL_SCOUT_DB') || env('SCOUT_DB') || './.scout/cache.db',
    web: () => env('RECALL_SCOUT_URL') || 'http://localhost:7950',
    sql: `SELECT p.title AS title, p.url AS ref, 'web' AS meta,
                 snippet(pages_fts, 2, '⟦', '⟧', ' … ', 14) AS excerpt, bm25(pages_fts) AS score
          FROM pages_fts JOIN pages p ON p.url = pages_fts.url
          WHERE pages_fts MATCH ? ORDER BY score LIMIT ?`,
    count_sql: `SELECT COUNT(*) n FROM pages_fts WHERE pages_fts MATCH ?`,
  },
  {
    name: 'code', label: 'lens',
    db: () => env('RECALL_LENS_DB') || env('LENS_DB') || './.lens/index.db',
    web: () => env('RECALL_LENS_URL') || 'http://localhost:7900',
    sql: `SELECT path AS title, path || ':' || CAST(start AS INTEGER) AS ref, lang AS meta,
                 snippet(chunks, 1, '⟦', '⟧', ' … ', 14) AS excerpt, bm25(chunks) AS score
          FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?`,
    count_sql: `SELECT COUNT(*) n FROM chunks WHERE chunks MATCH ?`,
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
  const matchedBy = {};       // what each store actually HAS, before any of our ceilings
  const corpusBy = {};        // how much is IN each store at all — an empty store is not an answer

  for (const store of STORES) {
    if (wanted && !wanted.has(store.name)) continue;
    const path = store.db();
    if (!existsSync(path)) continue;
    const db = openRO(path);
    if (!db) continue;
    searched.push(store.name);
    // How big was the haystack? Opening a missing store CREATES it — every sibling does
    // this — so a store that has never held anything still exists on disk, and recall
    // reported it as "searched". A briefing that says "0 hits across [brain, reading]"
    // when both are EMPTY is not an answer, it is a confident wrong one: the agent hears
    // "you know nothing about this", when the truth is "there is nothing here to know it
    // from". Count the corpus, and say so.
    try {
      const table = store.name === 'code' ? 'files' : store.name === 'reading' ? 'pages' : 'notes';
      corpusBy[store.name] = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    } catch { corpusBy[store.name] = null; }
    try {
      const rows = db.prepare(store.sql).all(m, Math.max(k * 2, 20));
      bySource[store.name] = rows.map((r) => ({ source: store.name, title: r.title, ref: r.ref,
        meta: r.meta, excerpt: (r.excerpt || '').replace(/\s+/g, ' ').trim(),
        score: Math.round(r.score * 1000) / 1000 }));
      // The candidate window (k*2) is itself a ceiling, so counting `rows` would
      // under-report. Ask the store how many it really has.
      try { matchedBy[store.name] = db.prepare(store.count_sql).get(m).n; }
      catch { matchedBy[store.name] = rows.length; }
    } catch { /* schema drift / fts error → skip this store */ } finally { db.close(); }
  }

  if (!wanted || wanted.has('team')) {
    const team = await fetchTeam(query, Math.max(k * 2, 20));
    // agent-hq answers over HTTP with a LIKE search, so what it returned is all we
    // can honestly claim to know it has.
    if (team) { searched.push('team'); bySource.team = team; matchedBy.team = team.length; }
  }

  // Interleave round-robin across stores (scores aren't comparable across sources)
  // so the briefing is balanced, filling to the token budget.
  for (const s in bySource) bySource[s].sort((a, b) => a.score - b.score);
  const order = ORDER.filter((s) => bySource[s]);
  const results = [];
  let tokens = 0, squeezed = 0;
  for (let i = 0; results.length < k; i++) {
    let progressed = false;
    for (const s of order) {
      const hit = bySource[s][i];
      if (!hit) continue;
      progressed = true;
      const tk = estTokens(hit.excerpt);
      if (tokens + tk <= max_tokens || results.length === 0) { results.push({ ...hit, tokens: tk }); tokens += tk; }
      else squeezed++;      // it matched; the budget is the only reason you can't see it
      if (results.length >= k) break;
    }
    if (!progressed) break;
  }

  // per-source breakdown of what actually made it into the briefing — so the UI
  // can show how the federated result is composed (e.g. 4 brain · 3 code · 2 reading).
  const by_source = {};
  for (const r of results) by_source[r.source] = (by_source[r.source] || 0) + 1;

  // What each store HAD versus what you were shown. Without this a briefing that
  // returned 10 of 32 matches looks exactly like a briefing that found 10 things —
  // and recall's whole promise is "you don't have to search the other four places",
  // which is only true if it admits when it didn't show you everything.
  const stores = {};
  for (const s of searched) {
    const matched = matchedBy[s] || 0;
    const shown = by_source[s] || 0;
    stores[s] = { shown, matched, withheld: Math.max(0, matched - shown), entries: corpusBy[s] ?? null };
  }
  const matched = Object.values(stores).reduce((a, x) => a + x.matched, 0);
  const withheld = Math.max(0, matched - results.length);
  // Two ceilings hold results back and they have different fixes: raising the
  // budget does nothing if `k` is what bound. Name the one that actually did it.
  const limited_by = withheld === 0 ? null : squeezed > 0 ? 'budget' : 'k';
  // The dangerous case: a store that matched and contributed NOTHING. The briefing
  // still reports "searched 4 of 4 stores" — fully confident — while a whole
  // corner of your memory is invisible. Say its name.
  const silent = searched.filter((s) => stores[s].matched > 0 && stores[s].shown === 0);
  // Stores that exist and hold nothing. "0 hits across [brain, reading]" reads as a
  // finding; "brain and reading are empty" is the actual situation, and only one of them
  // tells you the vault path is wrong.
  const empty = searched.filter((s) => stores[s].entries === 0);

  return { query, searched, count: results.length, tokens, results, by_source,
    stores, matched, withheld, limited_by, silent, empty, budget: max_tokens, k };
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

// Fuller context for a single briefing hit — the full note / page / code chunk
// behind a result, read straight from the store (capped), so you can preview it
// inline without leaving recall. Returns { source, ref, text, truncated, meta }.
const EXPAND_CAP = 1600;
export async function expand(source, ref) {
  ref = String(ref || '');
  const cap = (t) => { t = String(t || '').replace(/\r/g, ''); return { text: t.slice(0, EXPAND_CAP), truncated: t.length > EXPAND_CAP }; };
  if (source === 'team') {
    try {
      const res = await fetch(`${hqUrl()}/api/memory?limit=200`, { signal: AbortSignal.timeout(800) });
      if (res.ok) { const rows = await res.json(); const m = Array.isArray(rows) && rows.find((x) => x.id === ref);
        if (m) return { source, ref, ...cap(m.content), meta: m.namespace || null }; }
    } catch { /* platform down → null */ }
    return { source, ref, text: null, truncated: false };
  }
  const store = STORES.find((s) => s.name === source);
  if (!store) return { source, ref, text: null, truncated: false };
  const path = store.db();
  if (!existsSync(path)) return { source, ref, text: null, truncated: false };
  const db = openRO(path);
  if (!db) return { source, ref, text: null, truncated: false };
  try {
    if (source === 'brain') { const r = db.prepare('SELECT body FROM notes WHERE slug=? LIMIT 1').get(ref); if (r) return { source, ref, ...cap(r.body) }; }
    else if (source === 'reading') { const r = db.prepare('SELECT markdown FROM pages WHERE url=? LIMIT 1').get(ref); if (r) return { source, ref, ...cap(r.markdown) }; }
    else if (source === 'code') {
      const i = ref.lastIndexOf(':'); const p = i >= 0 ? ref.slice(0, i) : ref; const line = (i >= 0 ? parseInt(ref.slice(i + 1), 10) : 1) || 1;
      const r = db.prepare('SELECT body, CAST(start AS INTEGER) s, CAST("end" AS INTEGER) e FROM chunks WHERE path=? AND CAST(start AS INTEGER)<=? ORDER BY CAST(start AS INTEGER) DESC LIMIT 1').get(p, line);
      if (r) return { source, ref, ...cap(r.body), meta: `lines ${r.s}–${r.e}` };
    }
  } catch { /* schema drift → null */ } finally { db.close(); }
  return { source, ref, text: null, truncated: false };
}
