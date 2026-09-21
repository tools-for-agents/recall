// recall core — one query, all of an agent's memory. Federates FTS5 search over
// the sibling tools' indexes read-only: cortex (your second brain), scout (what
// you've read) and lens (your code). Returns a single token-budgeted briefing so
// an agent can load exactly the relevant context at the start of a task, instead
// of searching four places by hand. Decoupled: it only reads their stable schemas.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const estTokens = (s) => Math.ceil((s || '') .length / 4);
const env = (k) => process.env[k];

// SQLite's snippet() is superlinear in the size of the document it excerpts: 3ms on a 16KB row,
// 792ms at 256KB, and 142 SECONDS on a 4MB one — while the MATCH that found it costs 1ms. So ONE
// oversized row hangs every recall whose term it contains, with no error and no answer.
//
// recall is where this bites HARDEST and where it cannot be fixed upstream. recall federates over
// stores IT DOES NOT OWN — it opens cortex's, scout's and lens's SQLite files read-only and runs its
// OWN query — so no cap at any sibling's write() reaches it, and fixing cortex's search() did not
// fix this: recall never calls it. What the vault holds is the user's business (a cortex vault is
// Obsidian-compatible; a lens index chunks whatever is in the repo, and a minified bundle or a big
// JSON is ONE enormous chunk). recall must survive whatever it is pointed at.
//
// CASE short-circuits in SQLite, so snippet() is never evaluated past the cap. instr() is a plain C
// scan (2ms on the same 4MB body) so an oversized row still gets a REAL window around a REAL match
// rather than a head-of-document fob-off — and when the porter tokenizer matched by stem and no
// literal window exists, the row says so instead of passing its head off as the matching passage.
const SNIPPET_MAX = 64 * 1024; // bounds snippet() at ~30ms worst case; every real row is far below

// One shape, built once. Three hand-copied variants is how two of seven published ports came out
// wrong: what is typed three times is wrong in one of them.
const excerptSql = (fts, col, n) => `
  length(${fts}.${col}) AS chars,
  CASE WHEN length(${fts}.${col}) <= ? THEN snippet(${fts}, ${n}, '⟦', '⟧', ' … ', 14)
       ELSE substr(${fts}.${col}, MAX(1, instr(lower(${fts}.${col}), lower(?)) - 90), 240) END AS excerpt,
  CASE WHEN length(${fts}.${col}) <= ? THEN 1
       ELSE instr(lower(${fts}.${col}), lower(?)) > 0 END AS located`;
// Bind order follows the ? order in the text above: cap, probe, cap, probe.
const excerptArgs = (probe) => [SNIPPET_MAX, probe, SNIPPET_MAX, probe];

// Each store: where its DB lives (overridable) and how to query its FTS table.
// Every row is normalised to { title, ref, meta, excerpt, score } (bm25: lower = better).
//
// 🔑 bm25 score IS NOT UNIQUE, so ORDER BY score alone is not a defined order — two rows with the
// same term frequencies and length tie, and a tie falls back to rowid, which a re-index/re-sync of
// the underlying store changes. Each query tie-breaks on the row's stable identity: n.slug for
// cortex notes, p.url for scout pages, (path, start) for lens chunks — the JOINed ones qualified
// so the column is not ambiguous. Same class of fix that swept the sibling stores themselves; here
// it keeps recall's federated briefing from reordering under a store that reindexed beneath it.
const STORES = [
  {
    name: 'brain', label: 'cortex',
    db: () => env('RECALL_CORTEX_DB') || (env('CORTEX_VAULT') ? `${env('CORTEX_VAULT')}/.cortex/index.db` : './vault/.cortex/index.db'),
    web: () => env('RECALL_CORTEX_URL') || 'http://localhost:7800',
    sql: `SELECT n.title AS title, n.slug AS ref, n.type AS meta,
                 ${excerptSql('notes_fts', 'body', 3)}, bm25(notes_fts) AS score
          FROM notes_fts JOIN notes n ON n.slug = notes_fts.slug
          WHERE notes_fts MATCH ? ORDER BY score, n.slug LIMIT ?`,
    // How many this store ACTUALLY has — not how many fit the candidate window,
    // and certainly not how many survived the budget. See `stores` in recall().
    count_sql: `SELECT COUNT(*) n FROM notes_fts WHERE notes_fts MATCH ?`,
  },
  {
    name: 'reading', label: 'scout',
    db: () => env('RECALL_SCOUT_DB') || env('SCOUT_DB') || './.scout/cache.db',
    web: () => env('RECALL_SCOUT_URL') || 'http://localhost:7950',
    sql: `SELECT p.title AS title, p.url AS ref, 'web' AS meta,
                 ${excerptSql('pages_fts', 'markdown', 2)}, bm25(pages_fts) AS score
          FROM pages_fts JOIN pages p ON p.url = pages_fts.url
          WHERE pages_fts MATCH ? ORDER BY score, p.url LIMIT ?`,
    count_sql: `SELECT COUNT(*) n FROM pages_fts WHERE pages_fts MATCH ?`,
  },
  {
    name: 'code', label: 'lens',
    db: () => env('RECALL_LENS_DB') || env('LENS_DB') || './.lens/index.db',
    web: () => env('RECALL_LENS_URL') || 'http://localhost:7900',
    sql: `SELECT path AS title, path || ':' || CAST(start AS INTEGER) AS ref, lang AS meta,
                 ${excerptSql('chunks', 'body', 1)}, bm25(chunks) AS score
          FROM chunks WHERE chunks MATCH ? ORDER BY score, path, start LIMIT ?`,
    count_sql: `SELECT COUNT(*) n FROM chunks WHERE chunks MATCH ?`,
  },
];

// The literal term we probe an oversized row with. The FTS query ORs several terms; the first is
// the one to try, and when it does not occur literally `located` says so.
const probeTerm = (q) => (String(q).match(/[\p{L}\p{N}_]+/gu) || [''])[0];

function ftsQuery(q) {
  // \p{L}\p{N} (not [A-Za-z0-9]) so a query in any script — Turkish, Cyrillic, CJK —
  // tokenizes the SAME way each store's unicode61 index did; ASCII-only stripped every
  // non-Latin term to nothing and every federated store answered a ghost query.
  const terms = String(q).match(/[\p{L}\p{N}_]+/gu) || [];
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}

function openRO(path) {
  try { return new DatabaseSync(path, { readOnly: true }); } catch { return null; }
}

// The team's shared memory lives in agent-hq over HTTP, not a local DB. Query it if reachable;
// degrade silently (short timeout) when the platform isn't running — and LOUDLY when it is running
// and broken, because those are not the same fact about the team's memory.
const hqUrl = () => env('RECALL_HQ_URL') || env('HQ_URL') || 'http://localhost:7700';
const hqApi = () => `${hqUrl()}/api/memory`;
// ONE budget, named ONCE — every HTTP path here uses it and the failure messages below QUOTE it.
// A message carrying a number the code stopped using is exactly the small, confident lie this file
// is about: "no reply within 800ms" is evidence, and it stops being evidence the moment it is stale.
const HQ_TIMEOUT_MS = 800;

// What agent-hq sent instead of a list, named — "a JSON object (error)" is a lead; "no results" is not.
const shapeOf = (v) => v === null ? 'null'
  : typeof v === 'object' ? `a JSON object (${Object.keys(v).slice(0, 3).join(', ') || 'no keys'})`
    : `a JSON ${typeof v}`;
// Why a request never came back, in the socket's own words. One shape, built once — this sentence is
// written in two places (the probe and the drill-down) and the repo's rule holds: what is typed twice
// drifts in one of them, and a drifted diagnosis is the confident wrong answer in miniature. Never
// infer: a timeout is not proof the platform is down (a dropped SYN times out like a busy server),
// and ECONNREFUSED is not proof it is slow. Say what happened.
const netWhy = (e) => e?.name === 'TimeoutError' ? `no reply within the ${HQ_TIMEOUT_MS}ms budget`
  : `a connection failure (${e?.cause?.code || e?.cause?.message || e?.name || 'fetch failed'})`;
// A status code carries its own fix: 404 is almost always the URL, 5xx is almost always the platform.
const hqWhy = (s) => s === 404 ? 'wrong URL, or the memory API moved — check $RECALL_HQ_URL / $HQ_URL'
  : s === 401 || s === 403 ? 'agent-hq refused the request'
    : s >= 500 ? 'agent-hq is up but its memory API is failing'
      : 'agent-hq rejected the request';

// 🔑 A STORE THAT FAILED IS NOT A STORE WITH NO RESULTS — and over HTTP that is the easiest line in
// the tool to lose. This was `return res.ok ? await res.json() : []`, so EVERY non-2xx — a 500 with a
// JSON body, a 404 from an HQ_URL pointing at the wrong port, a 401 — was laundered into `[]`, the
// reachable-but-EMPTY sentinel. The briefing then read `searched [brain, code, team]` with
// `team: {matched: 0}`, no `silent`, no `failed`: an affirmative claim about the team's memory that
// recall never had the evidence to make, made at the exact moment the team store is broken and is the
// one holding the answer. The agent then re-derives the decision the team already made — the precise
// thing recall exists to prevent. Note how backwards it was: agent-hq NOT RUNNING (connection refused)
// was reported honestly, and agent-hq BROKEN-BUT-LISTENING was not. The loud failure was safe and the
// quiet one lied. The local SQLite stores have never been allowed this (see the catch in recall()).
//
// So: THREE outcomes, because there were always three.
//   an Array    → it answered with a list of memories. The ONLY outcome that may count as searched.
//   { error }   → reachable and BROKEN: a non-2xx, a reply recall could not read, or a body that is
//                 not a list. A 200 carrying {"error":"database is locked"} is this too — a shape
//                 recall cannot read is not an empty answer, it is an unanswered question.
//   { noreply } → this probe got no answer at all: nothing listening, or nothing back inside the
//                 budget. On its own that is NOT yet either of the two above — one probe cannot tell
//                 "the platform is not there" from "the platform is there and this term was slow".
//                 Only fetchTeam can, because only it sees whether the OTHER probes answered, so the
//                 reason travels up with it instead of being flattened to null here.
async function hqMemory(term, limit) {
  let res;
  try {
    res = await fetch(`${hqApi()}?q=${encodeURIComponent(term)}&limit=${limit}`,
      { signal: AbortSignal.timeout(HQ_TIMEOUT_MS) });
  } catch (e) { return { noreply: netWhy(e) }; }   // no answer at all — fetchTeam decides what it means
  if (!res.ok) return { error: `HTTP ${res.status} from ${hqApi()} — ${hqWhy(res.status)}; run \`recall status\`` };
  let rows;
  try { rows = await res.json(); }
  catch (e) {
    const why = /abort|timeout/i.test(e?.name || '') ? 'the reply timed out mid-body' : `the reply is not JSON (${e?.name || 'error'})`;
    return { error: `${hqApi()} answered ${res.status} but ${why} — that is not an empty team memory; run \`recall status\`` };
  }
  // A 200 whose body is not a list of memories is the same lie wearing a success code: agent-hq's API
  // moved under us, or something in front of it (a proxy, a login page) answered on its behalf.
  if (!Array.isArray(rows)) {
    return { error: `${hqApi()} answered ${res.status} with ${shapeOf(rows)}, not a list of memories — check agent-hq's API; run \`recall status\`` };
  }
  return rows;
}
// agent-hq's memory search is a single LIKE, so probe per term (in parallel) and
// merge — matching the OR-over-terms recall the other stores give.
async function fetchTeam(query, limit) {
  const terms = [...new Set((String(query).match(/[\p{L}\p{N}_]{2,}/gu) || []).map((t) => t.toLowerCase()))].slice(0, 6);
  const probes = await Promise.all((terms.length ? terms : [String(query)]).map((t) => hqMemory(t, limit)));
  // One broken probe costs more than the hits it lost: the merge below is what `matched` is counted
  // from, so a partial merge is an UNDERSTATED fact about the team's memory, stated with full
  // confidence. A SQLite store whose query throws fails whole; the HTTP store fails whole too.
  const broken = probes.find((p) => p?.error);
  if (broken) return broken;
  // …AND A PROBE THAT NEVER ANSWERED COSTS EXACTLY THE SAME, MORE QUIETLY. This is the half of the
  // fault that the 500 fix above did NOT close: a timed-out probe used to come back null and get
  // dropped from the merge, so ONE slow term — a big LIKE scan, a lock, a GC pause — took its
  // memories out of the briefing while `matched` went on being counted from what was left. The
  // result was `searched [team]`, `matched: 1`, `silent: []`, `withheld: 0`, no `failed`: the team's
  // highest-importance decision about the missing term simply gone, and EVERY field an agent checks
  // to detect an incomplete answer clean. Same lie as the 500, one layer in — which is why AGENTS.md
  // names "slow" in the same breath as "a 500 with a JSON body".
  //
  // Nothing answering at all is a different fact: recall never reached the platform, so it claims
  // nothing about the team's memory and the store is simply ABSENT, like a DB file that is not on
  // disk. It is the MIXTURE that must be loud — part of the question was answered, which makes the
  // reply INCOMPLETE rather than empty, and incomplete-looking-complete is the failure this tool
  // exists to prevent.
  const mute = probes.filter((p) => p?.noreply);
  if (mute.length === probes.length) return null; // never reached the platform → absent, not broken
  if (mute.length) {
    const why = [...new Set(mute.map((p) => p.noreply))].join(' / ');
    return { error: `${mute.length} of ${probes.length} term probes to ${hqApi()} got ${why}, `
      + `while others answered — the team's answer is INCOMPLETE, not empty; run \`recall status\`` };
  }
  const seen = new Map();
  for (const rows of probes) if (Array.isArray(rows)) for (const m of rows) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].map((m) => ({ source: 'team', title: m.title, ref: m.id, meta: m.namespace || 'default',
    excerpt: (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 240), score: -(m.importance || 3) }));
}

// Priority order for the round-robin interleave (your brain first, then the team,
// then what you've read, then code).
const ORDER = ['brain', 'team', 'reading', 'code'];
// The stores recall can federate. Derived from STORES (+ the HTTP-only 'team') so it never drifts
// from what actually gets searched.
const VALID_SOURCES = new Set([...STORES.map((s) => s.name), 'team']);

// ── federated recall ───────────────────────────────────────────────────────────
export async function recall(query, { k = 10, max_tokens = 2000, sources } = {}) {
  // Harden the numeric args: a bad value (NaN from a non-numeric query param,
  // zero, or negative) must fall back to the default rather than silently
  // emptying the briefing — `results.length < NaN` is always false, so an
  // unguarded NaN k returns zero results even when there are matches.
  k = Number.isFinite(+k) && +k > 0 ? Math.floor(+k) : 10;
  max_tokens = Number.isFinite(+max_tokens) && +max_tokens > 0 ? Math.floor(+max_tokens) : 2000;
  // A `sources` filter names a FINITE, KNOWN set. A name outside it (a typo — 'brian' for 'brain')
  // is not a query with no results, it is a MISTAKE — and silently returning nothing reads as "your
  // knowledge does not contain that" when the truth is "you asked for a store that is not there".
  // The MCP schema declares the enum but the CLI's `--only` and any direct caller do not; enforce it
  // at the one place every path goes through, and list the real stores so the fix is in the sentence.
  if (Array.isArray(sources)) {
    const bad = sources.filter((s) => !VALID_SOURCES.has(s));
    if (bad.length) {
      throw new Error(`no such store${bad.length > 1 ? 's' : ''}: ${bad.map((s) => `"${s}"`).join(', ')}`
        + ` — recall federates over ${[...VALID_SOURCES].join(', ')}. Check the spelling, or drop --only to search them all.`);
    }
  }
  const m = ftsQuery(query);
  if (!m) return { query, count: 0, tokens: 0, results: [] };
  const wanted = sources && sources.length ? new Set(sources) : null;
  const searched = [];
  const failed = {};             // a store whose query THREW — never silently counted as empty
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
      const rows = db.prepare(store.sql).all(...excerptArgs(probeTerm(query)), m, Math.max(k * 2, 20));
      bySource[store.name] = rows.map((r) => {
        const hit = { source: store.name, title: r.title, ref: r.ref,
          meta: r.meta, excerpt: (r.excerpt || '').replace(/\s+/g, ' ').trim(),
          score: Math.round(r.score * 1000) / 1000 };
        // Say so, rather than let the caller take this for the usual best-matching window.
        if (r.chars > SNIPPET_MAX) { hit.oversized = true; hit.chars = r.chars; hit.excerpt_is_match = !!r.located; }
        return hit;
      });
      // The candidate window (k*2) is itself a ceiling, so counting `rows` would
      // under-report. Ask the store how many it really has.
      try { matchedBy[store.name] = db.prepare(store.count_sql).get(m).n; }
      catch { matchedBy[store.name] = rows.length; }
    } catch (e) {
      // 🔑 A STORE THAT FAILED IS NOT A STORE WITH NO RESULTS.
      // This used to swallow the error and move on — but `searched` already names the store, so recall
      // reported "searched code · 0 matched · 1 entry", which an agent reads as "your code index has a
      // file in it and your term is NOT there." The truth was that the query THREW (schema drift, a
      // corrupt index, an fts5 build without the extension). Worse, the haystack size added in Cycle 15
      // to make an empty answer honest makes THIS one more convincing: it looks authoritative.
      // Name the failure, and do not let the store masquerade as searched-and-empty.
      failed[store.name] = String(e.message || e).slice(0, 160);
      delete matchedBy[store.name];
      delete bySource[store.name];
      const i = searched.indexOf(store.name);
      if (i >= 0) searched.splice(i, 1);
    } finally { db.close(); }
  }

  if (!wanted || wanted.has('team')) {
    const team = await fetchTeam(query, Math.max(k * 2, 20));
    // agent-hq answers over HTTP with a LIKE search, so what it returned is all we
    // can honestly claim to know it has — and ONLY a list is an answer.
    if (Array.isArray(team)) { searched.push('team'); bySource.team = team; matchedBy.team = team.length; }
    // Reachable-but-BROKEN goes where a throwing SQLite store goes: `failed`, by name, never into
    // `searched` with a `matched: 0` the caller reads as "the team has no record of this". (Not
    // running stays silently absent — a platform that isn't there is a missing store, not a broken
    // one.) The fix is at the END of these sentences ("run `recall status`", "check $HQ_URL") and the
    // URL in the middle of them is whatever the user configured, so the cap has to clear a real
    // hostname — truncate that tail away and the message keeps the alarm and loses the remedy.
    else if (team) failed.team = String(team.error).slice(0, 240);
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

  // `failed` is only present when a store actually broke. A briefing that says nothing about a store
  // it could not query is a briefing that quietly covers less than it claims.
  const out = { query, searched, count: results.length, tokens, results, by_source,
    stores, matched, withheld, limited_by, silent, empty, budget: max_tokens, k };
  if (Object.keys(failed).length) out.failed = failed;
  return out;
}

// ── which stores are available right now ──────────────────────────────────────
export async function status() {
  const stores = STORES.map((s) => {
    const path = s.db();
    const found = existsSync(path);
    let entries = null, broken = null;
    if (found) {
      const db = openRO(path);
      if (!db) {
        broken = 'the file exists but could not be opened read-only (locked, or not a database)';
      } else {
        try {
          const table = s.name === 'code' ? 'files' : s.name === 'reading' ? 'pages' : 'notes';
          entries = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
        } catch (e) {
          // status() is the command you run to find out WHY recall came back empty, so it must draw the
          // SAME line the query path draws: a store whose count THROWS (schema drift, a corrupt index, an
          // fts5 build without the extension) is BROKEN, not empty. Swallowing it here reported a broken
          // index as `available, entries: null` — the one lie this command exists to prevent.
          broken = String(e.message || e).slice(0, 160);
        }
        db.close();
      }
    }
    return { store: s.name, tool: s.label, source: path, web: s.web(),
      available: found && !broken, entries, ...(broken ? { broken: true, error: broken } : {}) };
  });
  const team = { store: 'team', tool: 'agent-hq', source: hqUrl(), web: hqUrl(), available: false, entries: null };
  try {
    const res = await fetch(`${hqApi()}?limit=1`, { signal: AbortSignal.timeout(HQ_TIMEOUT_MS) });
    // status() is what the query path's failure message TELLS YOU TO RUN, so it has to carry you to
    // the fix: a bare `available: false` reads as "agent-hq isn't running", and for a 404 (wrong port)
    // or a 500 (platform up, memory API broken) that sends you to restart something that is already
    // up. Same shape as the local stores: broken is a THIRD state, and it says why.
    if (!res.ok) { team.broken = true; team.error = `HTTP ${res.status} from ${hqApi()} — ${hqWhy(res.status)}`; }
    else {
      const rows = await res.json().catch((e) => e);
      if (Array.isArray(rows)) team.available = true;
      else { team.broken = true; team.error = `${hqApi()} answered ${res.status} with ${rows instanceof Error ? `a reply recall could not read (${rows.name})` : shapeOf(rows)}, not a list of memories`; }
    }
  } catch { /* platform not running → unavailable, and that is all we know */ }
  stores.push(team);
  return { stores };
}

// Fuller context for a single briefing hit — the full note / page / code chunk
// behind a result, read straight from the store (capped), so you can preview it
// inline without leaving recall. Returns { source, ref, text, truncated, meta }.
const EXPAND_CAP = 1600;
// How many memories agent-hq is asked for when drilling into a team hit. It has no
// get-one-by-id route, so this is a WINDOW, and the code below has to know it is one.
const TEAM_WINDOW = 200;
export async function expand(source, ref) {
  ref = String(ref || '');
  // A source names a FINITE, KNOWN set (the same one recall's --only draws from). A typo ('reeding') is a
  // MISTAKE, not a ref with no content — and expand's null-text below is the honest "not found" signal for a
  // real-but-empty ref, so an unknown source silently masquerades as "nothing there". recall() already
  // rejects this (Cycle 106); the drill-down path has to agree, or the SAME typo is loud in one call and
  // silent in the next. Name the value and the real stores, exactly as recall does.
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`no such store: "${source}" — recall federates over ${[...VALID_SOURCES].join(', ')}. `
      + `Check the spelling.`);
  }
  const cap = (t) => { t = String(t || '').replace(/\r/g, ''); return { text: t.slice(0, EXPAND_CAP), truncated: t.length > EXPAND_CAP }; };
  if (source === 'team') {
    // 🔑 THE SAME LAUNDERING AS hqMemory's, ONE FUNCTION OVER. This used to swallow every HTTP
    // failure and fall through to `text: null` — and `text: null` is expand's honest "that record
    // holds nothing", which the console renders as "Full text isn't available inline" and MCP hands
    // a model as a fact about the memory. So a 500'ing agent-hq made recall contradict itself in one
    // breath: `recall status` said `broken: true` while the drill-down said the memory was empty.
    // expand() is "GIVE ME EXACTLY THIS RECORD"; when recall could not ask, the answer is an ERROR,
    // never a record with nothing in it. (An unknown source already throws, just above.)
    let res;
    try { res = await fetch(`${hqApi()}?limit=${TEAM_WINDOW}`, { signal: AbortSignal.timeout(HQ_TIMEOUT_MS) }); }
    catch (e) { throw new Error(`cannot read that memory: ${hqApi()} gave ${netWhy(e)} — that is not an empty memory; run \`recall status\``); }
    if (!res.ok) throw new Error(`cannot read that memory: HTTP ${res.status} from ${hqApi()} — ${hqWhy(res.status)}; run \`recall status\``);
    let rows;
    try { rows = await res.json(); }
    catch (e) { throw new Error(`cannot read that memory: ${hqApi()} answered ${res.status} but recall could not read the reply (${e?.name || 'error'}); run \`recall status\``); }
    if (!Array.isArray(rows)) throw new Error(`cannot read that memory: ${hqApi()} answered ${res.status} with ${shapeOf(rows)}, not a list of memories; run \`recall status\``);
    const m = rows.find((x) => x.id === ref);
    if (m) return { source, ref, ...cap(m.content), meta: m.namespace || null };
    // agent-hq's memory API has no fetch-one-by-id, so this window is all recall can see. When it
    // came back FULL, "not in these rows" is not "not in agent-hq" — and null text would assert the
    // second from the first. Say which one recall actually knows.
    if (rows.length >= TEAM_WINDOW) {
      // Count what came back, not what was asked for: a platform that ignores `limit` would make
      // "the 200 memories" a made-up number in the one sentence whose job is to be careful.
      throw new Error(`cannot read that memory: "${ref}" is not among the ${rows.length} memories `
        + `${hqApi()} returned for a limit of ${TEAM_WINDOW}, and that window came back FULL — recall `
        + 'cannot fetch one memory by id, so it cannot tell "no such memory" from "outside that '
        + 'window". Open it in agent-hq.');
    }
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
