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
