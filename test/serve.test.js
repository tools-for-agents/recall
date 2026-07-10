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
