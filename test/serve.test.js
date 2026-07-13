// recall serve tests — spin the read-only console server over a throwaway brain
// index (other stores absent, team unreachable) and exercise the async handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'recall-serve-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const brainDb = join(dir, 'brain.db');
const db = new DatabaseSync(brainDb);
db.exec(`CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT);
         CREATE VIRTUAL TABLE notes_fts USING fts5(slug UNINDEXED, title, tags, body, tokenize='porter unicode61');`);
db.prepare('INSERT INTO notes VALUES (?,?,?)').run('rag', 'RAG', 'concept');
db.prepare('INSERT INTO notes_fts (slug,title,tags,body) VALUES (?,?,?,?)')
  .run('rag', 'RAG', 'ml', 'Retrieval augmented generation fetches relevant chunks for the model.');
db.close();

process.env.RECALL_CORTEX_DB = brainDb;
process.env.RECALL_SCOUT_DB = join(dir, 'absent-scout.db');
process.env.RECALL_LENS_DB = join(dir, 'absent-lens.db');
process.env.RECALL_HQ_URL = 'http://127.0.0.1:9';   // unreachable → team degrades fast

const { createRecallServer } = await import('../src/server.js');

test('serve: status, federated search, and the stats summary', async () => {
  const server = createRecallServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const status = await fetch(base + '/api/status').then((r) => r.json());
    assert.equal(status.stores.length, 4, 'status reports all four stores');
    assert.equal(status.stores.find((s) => s.store === 'brain').available, true, 'brain is available');
    assert.equal(status.stores.find((s) => s.store === 'reading').available, false, 'absent store is offline');
    // THE TEAM STORE IS THE ONE THAT LIVES OVER HTTP, and its availability defaults to false and
    // only becomes true if agent-hq actually answers. The test's HQ_URL points at an unreachable
    // host, so team MUST read offline — nothing was checking that, and a mutant defaulting it to
    // `available: true` would have recall claim the team store is live while the platform is down.
    // That is cycle 27's dead-end: a status screen that says a store is there when it is not.
    assert.equal(status.stores.find((s) => s.store === 'team').available, false,
      'the team store is offline when agent-hq is unreachable — recall must not claim a dead store is live');
    // each store exposes its web-view base url so the console can build cross-tool links
    assert.ok(status.stores.every((s) => typeof s.web === 'string' && /^https?:\/\//.test(s.web)), 'every store carries a web url');
    assert.match(status.stores.find((s) => s.store === 'code').web, /7900/, 'lens web url defaults to :7900');

    const r = await fetch(base + '/api/search?q=retrieval%20chunks').then((res) => res.json());
    assert.ok(r.searched.includes('brain'), 'search hit the available store');
    assert.ok(r.results.some((x) => x.ref === 'rag' && x.source === 'brain'), 'returns the brain note');
    assert.ok(r.tokens <= 2600, 'respects the token budget');

    // by_source: the per-source composition of the briefing (drives the header breakdown)
    const sum = Object.values(r.by_source).reduce((a, n) => a + n, 0);
    assert.equal(sum, r.count, 'by_source counts sum to the total result count');
    for (const [src, n] of Object.entries(r.by_source)) {
      assert.equal(r.results.filter((x) => x.source === src).length, n, `by_source[${src}] matches the results from that store`);
    }

    // robustness: a non-numeric ?k / ?tokens (→ NaN through +q.k) must not empty the
    // briefing — the endpoint should recover the same results as the default query
    const bad = await fetch(base + '/api/search?q=retrieval%20chunks&k=abc&tokens=xyz').then((res) => res.json());
    assert.equal(bad.count, r.count, 'bad numeric params fall back to defaults, not zero results');

    const only = await fetch(base + '/api/search?q=retrieval&only=reading').then((res) => res.json());
    assert.ok(!only.searched.includes('brain'), 'only= restricts which stores are queried');

    const stats = await fetch(base + '/api/stats').then((res) => res.json());
    assert.equal(stats.stores, 4);
    assert.ok(stats.available >= 1 && stats.entries >= 1, 'stats summarises live stores');
  } finally { server.close(); }
});

test('serve: the token budget is what binds — shrink it and the briefing sheds hits', async () => {
  // Each excerpt is a fixed ~32-token snippet, so a budget only bites when there
  // are many matches — seed a corpus deep enough that the budget, not the corpus,
  // is the limit.
  const db2 = new DatabaseSync(brainDb);
  const ins = db2.prepare('INSERT OR IGNORE INTO notes VALUES (?,?,?)');
  const insF = db2.prepare('INSERT INTO notes_fts (slug,title,tags,body) VALUES (?,?,?,?)');
  for (let i = 0; i < 30; i++) {
    ins.run(`chunk-${i}`, `Chunking note ${i}`, 'concept');
    insF.run(`chunk-${i}`, `Chunking note ${i}`, 'ml',
      `Retrieval augmented generation fetches relevant chunks for the model. Variant ${i}.`);
  }
  db2.close();

  const server = createRecallServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const search = (tokens) => fetch(`${base}/api/search?q=retrieval%20chunks&k=60&tokens=${tokens}`).then((r) => r.json());
  try {
    const big = await search(4000);
    const small = await search(400);

    assert.ok(big.tokens <= 4000 && small.tokens <= 400, 'neither briefing overspends its budget');
    assert.ok(small.count < big.count, 'a smaller budget yields a shorter briefing');
    assert.ok(small.tokens < big.tokens, 'and spends fewer tokens');
    assert.ok(big.tokens > 400, 'the bigger budget is actually used, not left on the table');
    // every hit reports its own cost, and they add up to the briefing's total
    assert.equal(big.results.reduce((a, h) => a + h.tokens, 0), big.tokens, 'per-hit costs sum to the briefing total');
  } finally { server.close(); }
});

test('searched: a store that answered nothing is not the same as a store that never answered', async () => {
  const server = createRecallServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    // the brain is present; scout + lens are absent files; agent-hq is unreachable
    // (the harness points them at nothing) — so only the brain can answer.
    const hit = await fetch(base + '/api/search?q=retrieval%20chunks').then((r) => r.json());
    assert.ok(hit.searched.includes('brain'), 'the store that answered is listed');
    assert.ok(!hit.searched.includes('reading'), 'a store whose file is absent never answered');
    assert.ok(!hit.searched.includes('code'), 'nor did the missing code index');
    assert.ok(!hit.searched.includes('team'), 'nor did the unreachable platform');

    // THE DISTINCTION THE UI RESTS ON: a store that was searched and found nothing
    // still reports as searched. Otherwise "we don't know" and "we never asked"
    // would be the same answer — and a partial briefing would look complete.
    const miss = await fetch(base + '/api/search?q=zzzz-nothing-matches-this').then((r) => r.json());
    assert.equal(miss.count, 0, 'nothing matched');
    assert.ok(miss.searched.includes('brain'), 'but the brain WAS asked — searched is not "found"');

    // and honouring a source filter narrows who is asked at all
    const only = await fetch(base + '/api/search?q=retrieval&only=reading').then((r) => r.json());
    assert.ok(!only.searched.includes('brain'), 'a store you excluded is not asked');
  } finally { server.close(); }
});

// RECALL'S ONE JOB IS TO RANK — AND ONLY ONE OF ITS FOUR STORES NEEDS IT TO.
//
// The three local stores come back from SQLite already sorted (`ORDER BY score`), so the JS
// comparator does nothing for them, and a test built on a cortex brain passes whether the sort is
// right or wrong. I wrote that test first. It was a decoration, and I only found out by flipping
// the comparator and watching it stay green.
//
// TEAM is the one that needs it. agent-hq's memory search is a single LIKE, probed once per term
// and merged — so the rows arrive in whatever order they were found in, scored only by
// `-(importance)`. The comparator is the ONLY thing that puts the important memory first.
//
// And it matters most exactly there: the briefing is token-budgeted, so a bad order does not
// reorder the answer — IT THROWS THE GOOD ANSWER AWAY. The agent never learns it existed.
test('the team briefing is ranked by importance — the comparator is the only thing that does it', async (t) => {
  const { createServer } = await import('node:http');
  // A fake agent-hq. It answers the LIKE probe in the WORST possible order: trivia first.
  const hq = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { id: 'mem-trivia', title: 'Trivia',    namespace: 'misc', content: 'sharding came up at lunch', importance: 1 },
      { id: 'mem-vital',  title: 'The rule',  namespace: 'eng',  content: 'NEVER reshard during business hours', importance: 5 },
      { id: 'mem-middle', title: 'A note',    namespace: 'eng',  content: 'sharding is by tenant', importance: 3 },
    ]));
  });
  await new Promise((r) => hq.listen(0, '127.0.0.1', r));
  t.after(() => hq.close());

  const prevHq = process.env.RECALL_HQ_URL, prevBrain = process.env.RECALL_CORTEX_DB;
  process.env.RECALL_HQ_URL = `http://127.0.0.1:${hq.address().port}`;
  process.env.RECALL_CORTEX_DB = join(dir, 'absent-brain.db');   // team only, so nothing else fills the budget
  try {
    const { recall } = await import(`../src/core.js?team=${Date.now()}`);
    const r = await recall('sharding', { k: 1, max_tokens: 4000 });
    assert.equal(r.results.length, 1, 'we asked for exactly one hit');
    assert.equal(r.results[0].ref, 'mem-vital',
      `with room for ONE hit you must get the most important memory — got "${r.results[0].ref}". `
      + 'The budget does not reorder a bad ranking; it DELETES what the ranking put last.');
  } finally {
    process.env.RECALL_HQ_URL = prevHq;
    process.env.RECALL_CORTEX_DB = prevBrain;
  }
});

// expand() IS "GIVE ME EXACTLY THIS RECORD", AND NOTHING WAS CHECKING THE "EXACTLY".
//
// It is how you read the full note / page / chunk behind a briefing hit without leaving recall.
// Zero tests touched it. The team branch matches the record with `rows.find(x => x.id === ref)`,
// and a mutant turned that into `!==` — which returns THE FIRST RECORD THAT IS NOT THE ONE YOU
// ASKED FOR, handed back under the ref you asked for. The suite stayed green.
//
// That is the confident-wrong-answer class in its purest form: you ask to see hit X, you are
// shown hit Y, and nothing about the answer invites a second look.
test('expand gives you the record you asked for — or nothing, never somebody else\'s', async (t) => {
  const { createServer } = await import('node:http');
  const hq = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { id: 'mem-a', title: 'A', namespace: 'ns', content: 'AAA the content of memory A', importance: 3 },
      { id: 'mem-b', title: 'B', namespace: 'ns', content: 'BBB the content of memory B', importance: 3 },
    ]));
  });
  await new Promise((r) => hq.listen(0, '127.0.0.1', r));
  t.after(() => hq.close());

  const prevHq = process.env.RECALL_HQ_URL;
  process.env.RECALL_HQ_URL = `http://127.0.0.1:${hq.address().port}`;
  try {
    const { expand } = await import(`../src/core.js?expand=${Date.now()}`);

    const b = await expand('team', 'mem-b');
    assert.match(b.text, /BBB/, 'you asked for mem-b and you get mem-b');
    assert.doesNotMatch(b.text, /AAA/, 'AND NOT MEMORY A — a record you did not ask for is not an answer');

    // …and a ref that exists nowhere gives you NOTHING, not the nearest thing lying around.
    const ghost = await expand('team', 'mem-does-not-exist');
    assert.equal(ghost.text, null,
      'a ref that matches nothing must come back empty — handing over some other record instead is '
      + 'how an agent ends up reasoning about a document it never asked to see');

    // …and the local store, by the same rule.
    //
    // NB: this needs its own brain, because THE FIXTURE AT THE TOP OF THIS FILE HAS NO `body`
    // COLUMN — it models cortex's notes table as (slug, title, type). Real cortex stores the body
    // there, and expand() reads it. So `expand('brain', …)` could never have worked against that
    // fixture, which is exactly why nobody ever tested it: the fake was faithful enough to SEARCH
    // and not faithful enough to READ. A faithful fake has to be faithful to the column you are
    // about to select.
    const { DatabaseSync: DB } = await import('node:sqlite');
    const realish = join(dir, 'expand-brain.db');
    const d3 = new DB(realish);
    d3.exec(`CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, body TEXT);
             CREATE VIRTUAL TABLE notes_fts USING fts5(slug UNINDEXED, title, tags, body, tokenize='porter unicode61');`);
    d3.prepare('INSERT INTO notes VALUES (?,?,?,?)').run('rag', 'RAG', 'concept', 'Retrieval augmented generation.');
    d3.prepare('INSERT INTO notes VALUES (?,?,?,?)').run('other', 'Other', 'note', 'Something else entirely.');
    d3.close();

    const prevBrain = process.env.RECALL_CORTEX_DB;
    process.env.RECALL_CORTEX_DB = realish;
    try {
      const { expand: expand2 } = await import(`../src/core.js?expandbrain=${Date.now()}`);
      const note = await expand2('brain', 'rag');
      assert.match(note.text, /Retrieval augmented generation/, 'the brain hands back the note you named');
      assert.doesNotMatch(note.text, /Something else entirely/, 'and not the one sitting next to it');
      assert.equal((await expand2('brain', 'no-such-slug')).text, null, 'and nothing at all for a slug that is not there');
    } finally { process.env.RECALL_CORTEX_DB = prevBrain; }
  } finally { process.env.RECALL_HQ_URL = prevHq; }
});

// THE STATIC SERVER MUST NEVER SERVE ITS OWN SOURCE, HOWEVER THE PATH IS SPELLED.
//
// The guard was startsWith(PUBLIC) with no trailing separator, so <repo>/public also prefixes
// <repo>/public-secrets — a sibling. That is a real weakness in the guard, and it is fixed
// (require PUBLIC + sep). But it turns out NOT to be reachable through this HTTP server: url.pathname
// is WHATWG-normalised, so a real `..` is collapsed before serveStatic ever sees it, and an encoded
// slash stays encoded (so `..%2f` is a literal filename, not a traversal). The iris shot-viewer hole
// WAS reachable because it read `id` from a query PARAMETER — decoded, never path-normalised. A path
// and a query value are not the same input.
//
// So this is a REGRESSION GUARD, honestly labelled: it passes today on both the old and new guard,
// and it exists to fail the day someone decodes %2f, reads a path from a query param, or otherwise
// hands serveStatic a string that still carries a traversal. It goes over a RAW SOCKET so `..` and
// `%2f` reach the wire intact — fetch() would sanitise them first.
test('no raw path — dotdot, encoded slash, or sibling spelling — leaks the server source', async (t) => {
  const { createConnection } = await import('node:net');
  const server = createRecallServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const rawGet = (rawPath) => new Promise((resolve, reject) => {
    const sock = createConnection(port, '127.0.0.1', () =>
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    let buf = ''; sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf)); sock.on('error', reject);
  });

  for (const attack of ['/../src/server.js', '/..%2fsrc%2fserver.js', '/%2e%2e/src/server.js', '/../package.json']) {
    const resp = await rawGet(attack);
    assert.doesNotMatch(resp, /createRecallServer|"dependencies"|import \{/,
      `a raw request escaped the public directory: ${attack}\n${resp.split('\r\n')[0]}`);
  }
  // and the real index is still served
  const ok = await rawGet('/index.html');
  assert.match(ok.split('\r\n')[0], /200/, 'the index is still served');
});

// …AND THE TEAM STORE READS LIVE WHEN AGENT-HQ ACTUALLY ANSWERS.
// One direction alone is a half-truth: offline-when-down must be matched by live-when-up, or the
// status could just always say "offline" and still pass the test above.
test('the team store is reported available when agent-hq responds', async (t) => {
  const { createServer } = await import('node:http');
  const hq = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');   // reachable, even if it has nothing — Array.isArray([]) is true
  });
  await new Promise((r) => hq.listen(0, '127.0.0.1', r));
  t.after(() => hq.close());

  const prev = process.env.RECALL_HQ_URL;
  process.env.RECALL_HQ_URL = `http://127.0.0.1:${hq.address().port}`;
  try {
    const { status } = await import(`../src/core.js?teamstatus=${Date.now()}`);
    const st = await status();
    const team = st.stores.find((s) => s.store === 'team');
    assert.equal(team.available, true, 'a reachable agent-hq means the team store is LIVE');
  } finally { process.env.RECALL_HQ_URL = prev; }
});
