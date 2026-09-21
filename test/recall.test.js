// recall tests — run with `node --test`. Builds a throwaway cortex-style index
// and points recall at it; no agent-hq needed (team store degrades silently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'recall-test-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

// a minimal cortex index (notes + notes_fts) recall can read
const brainDb = join(dir, 'brain.db');
const db = new DatabaseSync(brainDb);
db.exec(`CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, body TEXT);
         CREATE VIRTUAL TABLE notes_fts USING fts5(slug UNINDEXED, title, tags, body, tokenize='porter unicode61');`);
db.prepare('INSERT INTO notes VALUES (?,?,?,?)').run('rag', 'RAG', 'concept', 'Retrieval augmented generation fetches relevant chunks for the model. The full note body lives here.');
db.prepare('INSERT INTO notes_fts (slug,title,tags,body) VALUES (?,?,?,?)')
  .run('rag', 'RAG', 'ml', 'Retrieval augmented generation fetches relevant chunks for the model.');
db.close();

process.env.RECALL_CORTEX_DB = brainDb;
process.env.RECALL_SCOUT_DB = join(dir, 'none-scout.db');   // absent → skipped
process.env.RECALL_LENS_DB = join(dir, 'none-lens.db');     // absent → skipped
process.env.RECALL_HQ_URL = 'http://127.0.0.1:9';           // unreachable → team skipped fast

const r = await import('../src/core.js');

test('recall returns hits from an available store', async () => {
  const res = await r.recall('retrieval chunks');
  assert.ok(res.searched.includes('brain'));
  assert.ok(res.results.some((x) => x.ref === 'rag' && x.source === 'brain'));
  assert.ok(res.tokens <= 2000);
});

test('recall finds non-ASCII content — the query tokenizes like the unicode61 store index', async () => {
  // The stores index with unicode61 (every script); recall's query tokenizer kept only
  // [A-Za-z0-9] and so asked every federated store a ghost query for any non-Latin term.
  const d = new DatabaseSync(brainDb);
  d.prepare('INSERT INTO notes VALUES (?,?,?,?)').run('seyahat', 'İstanbul', 'note', 'İstanbul ve Москва ve 日本語 notları.');
  d.prepare('INSERT INTO notes_fts (slug,title,tags,body) VALUES (?,?,?,?)')
    .run('seyahat', 'İstanbul', 'tr', 'İstanbul ve Москва ve 日本語 notları.');
  d.close();
  for (const q of ['İstanbul', 'Москва', '日本語']) {
    const res = await r.recall(q);
    assert.ok(res.results.some((x) => x.ref === 'seyahat' && x.source === 'brain'),
      `recall must find the note for a ${q} query`);
  }
});

test('recall skips absent stores and unreachable team without hanging', async () => {
  const res = await r.recall('retrieval');
  assert.ok(!res.searched.includes('reading'));
  assert.ok(!res.searched.includes('code'));
  assert.ok(!res.searched.includes('team'));
});

test('empty / non-word query yields no results', async () => {
  const res = await r.recall('   ');
  assert.equal(res.count, 0);
});

test('sources filter restricts which stores are queried', async () => {
  const res = await r.recall('retrieval', { sources: ['reading'] });
  assert.ok(!res.searched.includes('brain'));
});

// `sources` names a finite, known set. A typo ('brian') is a MISTAKE, not a query with no results —
// silently returning nothing reads as "your knowledge does not contain that". Say so, name the stores.
test('a mistyped source is a named error, not a silent empty briefing', async () => {
  await assert.rejects(() => r.recall('retrieval', { sources: ['brian'] }),
    (e) => {
      assert.match(e.message, /no such store/i, 'it says the store does not exist');
      assert.match(e.message, /brian/, 'and names the one that was wrong');
      assert.match(e.message, /brain.*reading.*code.*team|team/, 'and lists the real stores');
      return true;
    });
  // one bad name among good ones still errors, and names the bad one specifically
  await assert.rejects(() => r.recall('retrieval', { sources: ['brain', 'readng'] }), /readng/);
  // Over-fire guard: valid sources and no filter at all must NOT throw.
  await assert.doesNotReject(() => r.recall('retrieval', { sources: ['brain', 'code'] }));
  await assert.doesNotReject(() => r.recall('retrieval'));
});

test('bad numeric args fall back to defaults instead of emptying the briefing', async () => {
  const good = await r.recall('retrieval chunks');
  assert.ok(good.count > 0, 'baseline has hits');

  // a non-numeric k (NaN — e.g. from ?k=abc) used to make `results.length < NaN`
  // always false, returning zero results even with matches
  for (const bad of [NaN, 0, -5, 'abc', undefined]) {
    const res = await r.recall('retrieval chunks', { k: bad });
    assert.equal(res.count, good.count, `k=${String(bad)} recovers the default result count`);
  }
  // a non-numeric max_tokens must not collapse the budget to a single hit
  const tok = await r.recall('retrieval chunks', { max_tokens: 'xyz' });
  assert.equal(tok.count, good.count, 'bad max_tokens falls back to the default budget');
  // a huge but valid k is still bounded by the available hits (no hang, no over-return)
  const big = await r.recall('retrieval chunks', { k: 100000 });
  assert.equal(big.count, good.count, 'k larger than the corpus just returns everything available');
});

// The lie one level below "searched 4 of 4": a store answers, matches plenty, and
// gets squeezed out of the briefing entirely — while the header still reports full
// coverage. "scout has nothing on this" and "scout's hits didn't fit" are not the
// same sentence, and recall used to speak only the first one.
test('a store can match and show you nothing — recall names it instead of looking complete', async () => {
  const readingDb = join(dir, 'reading.db');
  const d2 = new DatabaseSync(readingDb);
  d2.exec(`CREATE TABLE pages (url TEXT PRIMARY KEY, title TEXT, markdown TEXT);
           CREATE VIRTUAL TABLE pages_fts USING fts5(url UNINDEXED, title, markdown, tokenize='porter unicode61');`);
  for (let i = 0; i < 4; i++) {
    const url = `https://ex.com/${i}`, md = 'Retrieval augmented generation chunks, explained at some length.';
    d2.prepare('INSERT INTO pages VALUES (?,?,?)').run(url, `Retrieval ${i}`, md);
    d2.prepare('INSERT INTO pages_fts (url,title,markdown) VALUES (?,?,?)').run(url, `Retrieval ${i}`, md);
  }
  d2.close();

  const prev = process.env.RECALL_SCOUT_DB;
  process.env.RECALL_SCOUT_DB = readingDb;
  try {
    // A budget so tight only the top hit survives (the first is always let through —
    // an empty briefing atop real matches would be the worst lie of all).
    const tight = await r.recall('retrieval chunks', { k: 20, max_tokens: 1 });
    assert.equal(tight.count, 1);
    assert.equal(tight.limited_by, 'budget', 'the budget bound — raising k would change nothing');
    assert.deepEqual(tight.silent, ['reading'],
      'scout matched 4 pages and contributed none — that store is invisible, and must be NAMED');
    assert.equal(tight.stores.reading.matched, 4);
    assert.equal(tight.stores.reading.shown, 0);
    assert.equal(tight.withheld, 4);

    // Widen the budget and the invisible store comes back — the offer the UI makes is real.
    const wide = await r.recall('retrieval chunks', { k: 20, max_tokens: 5000 });
    assert.ok(wide.stores.reading.shown > 0, 'scout is visible again');
    assert.equal(wide.silent.length, 0);
    assert.equal(wide.withheld, 0);
    assert.equal(wide.limited_by, null, 'nothing withheld → no ceiling named, no crying wolf');

    // The result cap is a DIFFERENT ceiling with a different fix.
    const capped = await r.recall('retrieval chunks', { k: 2, max_tokens: 5000 });
    assert.equal(capped.count, 2);
    assert.equal(capped.limited_by, 'k', 'nothing was squeezed by tokens — the cap is the ceiling');
    assert.ok(capped.withheld > 0);
  } finally { process.env.RECALL_SCOUT_DB = prev; }
});

test('status reports all four stores', async () => {
  const s = await r.status();
  assert.equal(s.stores.length, 4);
  assert.deepEqual(s.stores.map((x) => x.store).sort(), ['brain', 'code', 'reading', 'team']);
  assert.equal(s.stores.find((x) => x.store === 'brain').available, true);
});

test('status names a BROKEN store as broken — never as available-and-empty', async () => {
  // status() is the command you run to find out WHY recall came back empty, so it must draw the same
  // line the query path draws: a store that is present but whose count THROWS (schema drift, a corrupt
  // index) is BROKEN, not empty. It used to `catch {}` and report it as available with entries:null —
  // indistinguishable from a real, working, empty store.
  const bad = join(dir, 'status-drifted.db');
  const d = new DatabaseSync(bad);
  d.exec('CREATE TABLE something_else (x TEXT);');    // a real db, but no `files` table → COUNT throws
  d.close();

  const saved = process.env.RECALL_LENS_DB;
  process.env.RECALL_LENS_DB = bad;
  try {
    const code = (await r.status()).stores.find((x) => x.store === 'code');
    assert.equal(code.available, false, 'a broken store is not available to search');
    assert.equal(code.broken, true, 'it is flagged broken, not left looking empty');
    assert.match(code.error, /no such table|files|error|sql/i, 'and it says why, so it is not a dead end');
    assert.equal(code.entries, null, 'entries stays null — never a fake 0 that reads as searched-and-empty');
  } finally { process.env.RECALL_LENS_DB = saved; }

  // ...and a healthy store must not cry wolf: no `broken` key at all.
  assert.equal('broken' in (await r.status()).stores.find((x) => x.store === 'brain'), false);
});

test('expand returns the full note body behind a hit, and null for an unknown ref', async () => {
  const e = await r.expand('brain', 'rag');
  assert.equal(e.source, 'brain');
  assert.match(e.text, /full note body lives here/, 'returns the full note body, not just the snippet');
  assert.equal(e.truncated, false, 'a short note is not truncated');

  const miss = await r.expand('brain', 'no-such-slug');
  assert.equal(miss.text, null, 'an unknown ref yields null text, not an error');

  const absent = await r.expand('reading', 'https://x');   // scout store not configured in this test
  assert.equal(absent.text, null, 'an absent store degrades to null');
});

// ── An empty store is not a finding ─────────────────────────────────────────────
test('recall says when the stores it searched are EMPTY, instead of reporting no hits', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // Exactly what happens in the wild: every sibling CREATES its store on open, so a tool
  // that has never held anything still exists on disk. recall then searched it and
  // reported "0 hits across [brain, reading]" — which reads as a finding about the world
  // rather than a fact about the configuration. The agent hears "you know nothing about
  // this" when the truth is "there is nothing here to know it from".
  const dir = mkdtempSync(join(tmpdir(), 'recall-empty-'));
  const brain = join(dir, 'brain.db');
  const db = new DatabaseSync(brain);
  db.exec(`CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, body TEXT);
           CREATE VIRTUAL TABLE notes_fts USING fts5(slug UNINDEXED, title, tags, body, tokenize='porter unicode61');`);
  db.close();   // real store, real tables, zero rows

  const prev = process.env.RECALL_CORTEX_DB;
  process.env.RECALL_CORTEX_DB = brain;
  const fresh = await import(`../src/core.js?empty=${Date.now()}`);
  const res = await fresh.recall('retrieval');
  process.env.RECALL_CORTEX_DB = prev;
  rmSync(dir, { recursive: true, force: true });

  assert.ok(res.searched.includes('brain'), 'the store exists, so it was searched');
  assert.equal(res.stores.brain.entries, 0, 'and it holds nothing — the size of the haystack is reported');
  assert.deepEqual(res.empty, ['brain'], 'and it is NAMED as empty, so "0 hits" cannot be mistaken for an answer');
});

// ── stdout IS the protocol ──────────────────────────────────────────────────────
// An MCP server speaks newline-delimited JSON-RPC on stdout and NOTHING else.
//
// One console.log anywhere in a code path a tool can reach — a leftover debug line, a
// helpful progress message — puts a line on that stream which is not a message. The
// client desyncs. It does not fail loudly: the call simply never comes back, or comes
// back as the wrong reply to the wrong request, and the agent is left holding a session
// that has quietly stopped working. It is the single easiest way to break an MCP server,
// and the hardest to notice, because everything still LOOKS fine.
//
// A dynamic check cannot cover this: it only sees the code paths it happens to exercise,
// and a debug line inside `search()` is invisible until someone searches. So walk the
// import graph from the server itself and refuse the whole class.
//
// `cli.js` and `server.js` are the CLI and the `serve` command — they are meant to print,
// and the MCP server never imports them. If that ever changes, this test is what tells you.
test('nothing the MCP server can reach is allowed to print to stdout', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');

  const entry = resolve(import.meta.dirname, '..', 'mcp', 'mcp-server.js');
  const seen = new Set();
  const offenders = [];

  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');

    // The server itself writes the protocol — that is its job. Everything it pulls in must not.
    if (file !== entry) {
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment about it is fine
        if (/console\.(log|info|debug|dir|table)\s*\(|process\.stdout\.write\s*\(/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);

  // agent-hq's MCP server imports nothing local — it is a thin HTTP client over the
  // platform's API — so for it this walk finds only the entry file, and there is genuinely
  // nothing to check. That is not a vacuous pass: it is the guard that fires the day
  // somebody wires the server straight into services.js, which does print.
  assert.ok(seen.size >= 1, 'the entry point was found');
  assert.deepEqual(offenders, [],
    'stdout is the protocol — one stray print desyncs every agent session:\n  ' + offenders.join('\n  '));
});

// ── `k` is a promise too, and nothing was holding it ────────────────────────────────
test('k is a ceiling, not a suggestion — with two stores answering, asking for k gets k', async () => {
  // Mutation testing found this: flip `results.length >= k` to `>` and recall hands back
  // k+1 hits with the whole suite still green. The token budget WAS pinned by a test; the
  // result COUNT never was. Both are promises the caller plans around — an agent that asks
  // for 3 and is handed 4 has had its context budget spent for it, without being asked.
  //
  // It can only overshoot when SEVERAL stores are answering, because the overshoot happens
  // inside the round-robin across them — and federating several stores is recall's entire
  // reason to exist, so this was the one shape its tests never had. My first two attempts
  // at this test COULD NOT FAIL: one used the single-store fixture, and one seeded bodies
  // whose function names (`retrieval0`) the porter tokenizer reads as a single token, so
  // searching "retrieval" never matched them and the second store contributed nothing.
  // A test that cannot fail is decoration. Both were thrown away.
  const codeDb = join(dir, 'code.db');
  const cdb = new DatabaseSync(codeDb);
  cdb.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, lang TEXT, lines INTEGER, bytes INTEGER, mtime INTEGER, indexed_at TEXT);
            CREATE VIRTUAL TABLE chunks USING fts5(path, body, lang UNINDEXED, start UNINDEXED, "end" UNINDEXED, tokenize='porter unicode61');`);
  const insF = cdb.prepare('INSERT OR IGNORE INTO files VALUES (?,?,?,?,?,?)');
  const insC = cdb.prepare('INSERT INTO chunks (path, body, lang, start, "end") VALUES (?,?,?,?,?)');
  for (let i = 0; i < 20; i++) {
    insF.run(`/repo/src/ceil${i}.js`, 'javascript', 3, 90, 0, new Date(0).toISOString());
    insC.run(`/repo/src/ceil${i}.js`, `function ceil${i}() { return retrieval(chunks, ${i}); }`, 'javascript', 1, 3);
  }
  cdb.close();

  // Store paths are read per call, so light the second store up here and put the world
  // back afterwards — three other tests in this file rely on `code` being ABSENT, and a
  // fixture change that breaks three tests to fix one is not a fix.
  const saved = process.env.RECALL_LENS_DB;
  process.env.RECALL_LENS_DB = codeDb;
  try {
    // Prove the setup FIRST, with a k big enough that both stores get a turn. (At k=1 only
    // one source can contribute by definition, so asserting "two sources" inside the loop
    // fails by construction — my third mistake on this one test, caught by the precondition
    // I had put there precisely to catch it.)
    const probe = await r.recall('retrieval', { k: 10, max_tokens: 100000 });
    const contributing = new Set(probe.results.map((x) => x.source));
    assert.ok(contributing.size >= 2,
      `precondition: both stores must actually CONTRIBUTE hits, else the ceiling can never be overshot (got ${[...contributing]})`);

    for (const k of [1, 2, 3]) {
      const res = await r.recall('retrieval', { k, max_tokens: 100000 });
      assert.ok(res.results.length <= k, `asked for ${k}, got ${res.results.length}`);
    }
  } finally { process.env.RECALL_LENS_DB = saved; }
});

test('ONE oversized row in a store recall does not own must not hang the whole briefing', async () => {
  // snippet() is superlinear in the size of the row it excerpts: 3ms at 16KB, 792ms at 256KB, and
  // 142 SECONDS at 4MB — while the MATCH that found it costs 1ms. Pointed at a real vault holding
  // one 4MB note, recall took 188,877ms — over THREE MINUTES — and then answered. It never errors;
  // it just stops, which for the tool an agent is told to call FIRST is the worst possible shape.
  //
  // recall is where this cannot be fixed upstream: it federates over stores it DOES NOT OWN, opening
  // cortex's/scout's/lens's SQLite files read-only and running its OWN query. No cap at any sibling's
  // write() reaches it, and fixing cortex's search() did not fix this — recall never calls it.
  const big = new DatabaseSync(brainDb);
  const body = 'zzhugetopic lorem ipsum dolor sit amet '.repeat(Math.floor((1024 * 1024) / 39));
  big.prepare('INSERT INTO notes VALUES (?,?,?,?)').run('huge', 'The Huge One', 'note', body);
  big.prepare('INSERT INTO notes_fts (slug,title,tags,body) VALUES (?,?,?,?)').run('huge', 'The Huge One', '', body);
  big.close();

  const t0 = Date.now();
  const res = await r.recall('zzhugetopic');
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `recall over a 1MB row must stay bounded — took ${ms}ms (10.7s+ unfixed)`);

  const hit = res.results.find((x) => x.ref === 'huge');
  assert.ok(hit, 'and the row is still FOUND — bounding the excerpt must not drop the result');
  assert.equal(hit.oversized, true, 'an oversized row says so');
  assert.ok(hit.chars > 1e6, 'and reports its real size');
  assert.equal(hit.excerpt_is_match, true, 'instr() still found a REAL window around a REAL match');
  assert.match(hit.excerpt, /zzhugetopic/, 'so the excerpt actually contains the term');

  // A normal row is untouched: still snippet()-highlighted, still unflagged.
  const normal = (await r.recall('retrieval chunks')).results.find((x) => x.ref === 'rag');
  assert.ok(normal, 'normal rows still match');
  assert.equal(normal.oversized, undefined, 'a normal row is not flagged oversized');
  assert.match(normal.excerpt, /⟦/, 'and still gets snippet() highlighting — behaviour is unchanged');
});

test('a store that FAILED is not a store with NO RESULTS — it must never be swallowed', async () => {
  // recall used to `catch { /* schema drift → skip this store */ }`. But `searched` already named the
  // store, so a store whose query THREW came back as "searched · 0 matched · 1 entry" — which an agent
  // reads as "your code index has a file in it and your term is NOT there." The truth was that the
  // query blew up. Worse: the haystack size (added so an EMPTY answer would be honest) makes THIS
  // answer look authoritative. A store that is empty is a fact about the world; a store that BROKE is
  // a fact about the tool, and only one of them means the briefing is incomplete.
  const bad = join(dir, 'drifted.db');
  const d = new DatabaseSync(bad);
  d.exec(`CREATE TABLE files (path TEXT);
          CREATE VIRTUAL TABLE chunks USING fts5(path, wrongcol);`);   // no 'body' → the query throws
  d.prepare('INSERT INTO files VALUES (?)').run('a.js');
  d.close();

  const saved = process.env.RECALL_LENS_DB;
  process.env.RECALL_LENS_DB = bad;
  try {
    const res = await r.recall('retrieval');
    assert.ok(!res.searched.includes('code'), 'a store that threw must NOT be claimed as searched');
    assert.ok(res.failed && res.failed.code, 'it is reported as FAILED, not silently dropped');
    assert.match(res.failed.code, /no such column|error|sql/i, 'naming why, so it is not a dead end');
    assert.ok(res.searched.includes('brain'), 'and the healthy stores still answer');
    assert.ok(res.results.length > 0, 'the briefing still comes back — one broken store is not a total loss');
  } finally { process.env.RECALL_LENS_DB = saved; }

  // And it must not cry wolf: a healthy recall has no `failed` key at all.
  const ok = await r.recall('retrieval');
  assert.equal('failed' in ok, false, 'a healthy briefing carries no failure report');
});

// ── the HTTP twin of the test above, and the one the federation never had ───────
//
// The team store is the only one recall reaches over HTTP, and it is the one store whose silence
// causes a WRONG decision rather than a redundant one: it holds "we decided X". `hqMemory` used to
// end `return res.ok ? await res.json() : []` — and `[]` is the reachable-but-EMPTY sentinel, the
// line right below it says so. So a 500 with a JSON body, a 404 from an HQ_URL on the wrong port, a
// 401, all came back as "asked, nothing there": the briefing said `searched [brain, code, team]`
// with `team: {shown:0, matched:0}`, `silent: []`, and no `failed` key. Every field an agent would
// check to spot an incomplete answer was clean. `matched: 0` is not a missing value — it is an
// affirmative claim about the team's memory, made from a 500.
//
// The give-away that it was backwards: agent-hq NOT RUNNING was reported honestly (team absent from
// `searched`), and agent-hq UP-BUT-BROKEN was not. The loud failure was safe; the quiet one lied.
// AGENTS.md asks for exactly this test — "a 500 that is not checked for `r.ok` comes back looking
// exactly like data" — and every fake agent-hq in this suite answered 200.
test('an agent-hq that answers BADLY is a FAILED store, not an empty one', async (t) => {
  const { createServer } = await import('node:http');

  // One fake platform, flipped per case — so every branch is the same server, the same query and
  // the same instant, and only agent-hq's health differs.
  let mode = 'ok';
  const MEMS = [{ id: 'mem-budget', title: 'Chunk size for the code index', namespace: 'decisions',
    content: 'The team decided retrieval chunks are capped at 60 lines.', importance: 5 }];
  const hq = createServer((req, res) => {
    const J = { 'content-type': 'application/json' };
    if (mode === '500') { res.writeHead(500, J); return res.end('{"error":"database is locked"}'); }
    if (mode === '404') { res.writeHead(404, J); return res.end('{"error":"not found"}'); }
    if (mode === '401') { res.writeHead(401, J); return res.end('{"error":"unauthorized"}'); }
    if (mode === 'shape') { res.writeHead(200, J); return res.end('{"memories":[],"total":0}'); }
    if (mode === 'garbage') { res.writeHead(200, J); return res.end('<html><body>please log in</body></html>'); }
    // SLOW, the third failure AGENTS.md names: headers land, the body never does.
    if (mode === 'stall') { res.writeHead(200, J); return res.write('[{"id":"mem-bud'); }
    if (mode === 'empty') { res.writeHead(200, J); return res.end('[]'); }
    res.writeHead(200, J); res.end(JSON.stringify(MEMS));
  });
  await new Promise((r) => hq.listen(0, '127.0.0.1', r));
  t.after(() => { hq.closeAllConnections?.(); hq.close(); });   // the stalled reply still holds a socket

  const base = `http://127.0.0.1:${hq.address().port}`;
  const prev = process.env.RECALL_HQ_URL;
  process.env.RECALL_HQ_URL = base;
  // Warm the origin first. The 800ms probe budget is right for a live server, but the first fetches
  // to a just-created localhost server pay a cold start measured at ~803ms on a loaded box (see
  // serve.test.js) — and a timed-out probe is the UNREACHABLE branch, a different sentinel, so a
  // cold start would quietly test the wrong thing. Same reason `ask` retries: the mock is up the
  // whole time, so a probe that lands warm proves the point, and if none of five do, that is real.
  await fetch(`${base}/api/memory?limit=1`).catch(() => {});
  const ask = async (q) => {
    let res;
    for (let i = 0; i < 5; i++) {
      res = await r.recall(q);
      if (res.searched.includes('team') || res.failed?.team) break;   // the platform answered at all
    }
    return res;
  };

  try {
    // PRECONDITION FIRST: a fake that never answers would "fail" in every mode and the assertions
    // below would pass for the wrong reason. Prove this agent-hq really does reach the briefing.
    mode = 'ok';
    const live = await ask('retrieval chunks');
    assert.ok(live.searched.includes('team'), 'precondition: a healthy agent-hq IS searched');
    assert.ok(live.results.some((x) => x.source === 'team' && x.ref === 'mem-budget'),
      'precondition: and the team memory reaches the briefing — this store really does hold the answer');
    assert.equal('failed' in live, false, 'a healthy team store must not cry wolf');

    // Every way a listening agent-hq can answer without answering. The wording differs because the
    // FIX differs — a 404 is your HQ_URL, a 500 is the platform, a non-list is its API — but the
    // verdict never does: not searched, not counted, named in `failed`.
    for (const [m, why] of [['500', /HTTP 500/], ['404', /HTTP 404/], ['401', /HTTP 401/],
      ['shape', /not a list of memories/i], ['garbage', /not JSON/i], ['stall', /timed out/i]]) {
      mode = m;
      const res = await ask('retrieval chunks');
      assert.ok(!res.searched.includes('team'),
        `${m}: a store that could not answer must NOT be claimed as searched — got ${JSON.stringify(res.searched)}`);
      assert.equal(res.stores.team, undefined,
        `${m}: and must carry no matched count — "matched: 0" is an affirmative claim about the team's memory`);
      assert.ok(res.failed?.team, `${m}: it is reported as FAILED, the way a broken SQLite store is`);
      assert.match(res.failed.team, why, `${m}: naming what went wrong`);
      assert.match(res.failed.team, /api\/memory/, `${m}: and where it looked`);
      assert.match(res.failed.team, /recall status|HQ_URL/, `${m}: and what to run to fix it`);
      assert.ok(res.searched.includes('brain'), `${m}: the healthy stores still answer`);
      assert.ok(res.results.length > 0, `${m}: one broken store is not a total loss`);
    }

    // THE NEIGHBOUR THAT MUST NOT TRIP. An agent-hq that is up and genuinely holds nothing is still
    // searched-and-empty: "the team has no record of this" is a real answer and the most useful one
    // recall gives at the start of a task. Turning it into a failure would be the same lie mirrored.
    mode = 'empty';
    const none = await ask('retrieval chunks');
    assert.ok(none.searched.includes('team'), 'a reachable, empty agent-hq IS searched');
    assert.equal(none.stores.team.matched, 0, 'and honestly reports that nothing matched');
    assert.equal('failed' in none, false, 'an empty team store is not a failure');

    // …and the command the failure message tells you to run must agree with it. `available: false`
    // alone reads as "agent-hq isn't running", which for a 500 sends you to restart something that
    // is already up.
    mode = '500';
    let st;
    for (let i = 0; i < 5; i++) { st = (await r.status()).stores.find((x) => x.store === 'team'); if (st.broken) break; }
    assert.equal(st.available, false, 'a broken platform is not available to search');
    assert.equal(st.broken, true, 'status names it BROKEN, not merely offline');
    assert.match(st.error, /HTTP 500/, 'and says what agent-hq actually answered');

    // over-fire guard: a healthy agent-hq carries no `broken` key at all
    mode = 'ok';
    let live2;
    for (let i = 0; i < 5; i++) { live2 = (await r.status()).stores.find((x) => x.store === 'team'); if (live2.available) break; }
    assert.equal(live2.available, true, 'a healthy agent-hq is available');
    assert.equal('broken' in live2, false, 'and is not flagged broken');
  } finally { process.env.RECALL_HQ_URL = prev; }
});

// ── the OTHER half of the same fault: the probe that never came back ────────────
//
// The test above closes the 500. This one closes the case AGENTS.md names right beside it — "down,
// SLOW, or a 500 with a JSON body" — and it is the quieter of the two, because nothing about it
// looks like a failure at any layer.
//
// agent-hq's memory search is one LIKE per term, so recall probes PER TERM in parallel and merges.
// A probe that timed out came back `null` and was simply skipped by the merge: `for (const rows of
// probes) if (Array.isArray(rows))`. The store was still reported `searched`, and `matched` was
// still counted — from the terms that DID answer. One slow term (a big LIKE scan, a row lock, a GC
// pause) therefore removed its memories from the briefing and left behind
//     searched: ['team'], stores.team: { shown: 1, matched: 1, withheld: 0 }, silent: [], no failed
// which is an affirmative, UNDERSTATED claim about the team's memory: every field an agent would
// check to spot an incomplete answer is clean, and the decision it needed is the one that is gone.
//
// Nothing answering at all is a different fact and must stay quiet — recall never reached the
// platform, so it claims nothing. It is the MIXTURE that has to be loud.
test('a term probe that never answers makes the team store INCOMPLETE, not smaller', async (t) => {
  const { createServer } = await import('node:http');

  // A healthy agent-hq that is slow — or dies — for exactly ONE term. The other term answers
  // normally, which is the whole point: the platform is up and recall got a partial answer.
  const MEMS = {
    budget: { id: 'm-budget', title: 'Token budget is mandatory', namespace: 'decisions',
      content: 'The team decided every retrieval call must carry a token budget.', importance: 5 },
    chunk: { id: 'm-chunk', title: 'Chunk size for the code index', namespace: 'decisions',
      content: 'Retrieval chunks are capped at 60 lines.', importance: 4 },
  };
  let slow = [];          // terms the platform stalls on (longer than the probe budget)
  let reset = [];         // terms whose connection it drops on the floor
  const hq = createServer(async (req, res) => {
    const term = (new URL(req.url, 'http://x').searchParams.get('q') || '').toLowerCase();
    if (reset.includes(term)) return req.destroy();
    if (slow.includes(term)) await new Promise((r) => setTimeout(r, 2500));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(MEMS[term] ? [MEMS[term]] : []));
  });
  await new Promise((r) => hq.listen(0, '127.0.0.1', r));
  t.after(() => { hq.closeAllConnections?.(); hq.close(); });   // stalled replies still hold sockets

  const prev = process.env.RECALL_HQ_URL, prevBrain = process.env.RECALL_CORTEX_DB;
  process.env.RECALL_HQ_URL = `http://127.0.0.1:${hq.address().port}`;
  process.env.RECALL_CORTEX_DB = join(dir, 'absent-brain.db');   // team only: nothing else to hide behind
  await fetch(`${process.env.RECALL_HQ_URL}/api/memory?q=chunk&limit=1`).catch(() => {});  // warm the origin

  // A cold origin can blow the 800ms budget on EVERY probe, which is the all-mute case — a different
  // sentinel, and retrying is how we avoid testing it by accident. The bug's own signature is the
  // opposite (team PRESENT in `searched`), so this retry cannot hide it.
  const ask = async (q) => {
    let res;
    for (let i = 0; i < 5; i++) {
      res = await r.recall(q);
      if (res.searched.includes('team') || res.failed?.team) break;
      }
    return res;
  };

  try {
    // PRECONDITION: this platform really does answer both terms, and both memories really do reach
    // the briefing. Without this the assertions below would pass against a server that answers nothing.
    slow = []; reset = [];
    const live = await ask('budget chunk');
    assert.ok(live.searched.includes('team'), 'precondition: a healthy agent-hq is searched');
    assert.equal(live.stores.team.matched, 2, 'precondition: and both terms contribute — got '
      + JSON.stringify(live.stores.team));
    assert.equal('failed' in live, false, 'precondition: nothing is broken here');

    // ONE SLOW TERM. m-budget — the team's highest-importance decision — is what goes missing.
    slow = ['budget'];
    const part = await ask('budget chunk');
    assert.ok(!part.searched.includes('team'),
      `a store that answered half the question was not searched — got ${JSON.stringify(part.searched)} `
      + `with ${JSON.stringify(part.stores.team)}`);
    assert.equal(part.stores.team, undefined,
      'and carries no matched count: "matched: 1" here is an understated claim about the team\'s memory, '
      + 'stated with the same confidence as a complete one');
    assert.ok(part.failed?.team, 'it is reported as FAILED, the way a 500 and a broken SQLite store are');
    assert.match(part.failed.team, /1 of 2 term probes/, 'saying how much of the question went unanswered');
    assert.match(part.failed.team, /no reply within the \d+ms budget/, 'and what happened to it');
    assert.match(part.failed.team, /INCOMPLETE/, 'and that this is incompleteness, not emptiness');
    assert.match(part.failed.team, /api\/memory/, 'and where it looked');
    assert.match(part.failed.team, /recall status/, 'and what to run next — the fix must survive the cap');
    assert.doesNotMatch(part.failed.team, /connection failure/,
      'a timeout is not a refused connection — a diagnosis that names the wrong cause sends you to fix '
      + 'the wrong thing');
    assert.ok(!part.results.some((x) => x.source === 'team'),
      'and the half-answer is not quietly used as if it were the whole one');

    // A DIFFERENT INPUT, THE SAME FAULT: the probe does not time out, it is CUT OFF. Same shape
    // (one term answered, one did not), and the message must report what really happened.
    slow = []; reset = ['budget'];
    const cut = await ask('budget chunk');
    assert.ok(!cut.searched.includes('team'), 'a dropped connection is not an empty term either');
    assert.ok(cut.failed?.team, 'still a FAILED store');
    assert.match(cut.failed.team, /1 of 2 term probes/, 'still naming how much was lost');
    assert.match(cut.failed.team, /connection failure/, 'and this time it really was the connection');
    assert.doesNotMatch(cut.failed.team, /no reply within/, 'and it must not claim a timeout it did not see');

    // OVER-FIRE GUARD 1 — the platform answering NOTHING is the absent case, and it must stay quiet.
    // recall never reached it, so it claims nothing about the team; crying "INCOMPLETE" here would be
    // the mirror-image lie (a failure report about a store that was never there).
    slow = ['budget', 'chunk']; reset = [];
    const none = await r.recall('budget chunk');
    assert.ok(!none.searched.includes('team'), 'an unreachable platform is not searched');
    assert.equal('failed' in none, false,
      `nothing answered, so nothing BROKE — got ${JSON.stringify(none.failed)}`);

    // OVER-FIRE GUARD 2 — and a healthy platform still answers in full. A guard that turns the
    // correct answer into an error costs more than the bug it closed.
    slow = []; reset = [];
    const well = await ask('budget chunk');
    assert.ok(well.searched.includes('team'), 'a healthy agent-hq is searched');
    assert.equal(well.stores.team.matched, 2, 'with every term counted');
    assert.equal('failed' in well, false, 'and no failure report');
    assert.ok(well.results.some((x) => x.ref === 'm-budget'), 'and the important memory is in the briefing');
  } finally {
    process.env.RECALL_HQ_URL = prev;
    process.env.RECALL_CORTEX_DB = prevBrain;
  }
});
