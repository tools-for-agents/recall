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
