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

    const r = await fetch(base + '/api/search?q=retrieval%20chunks').then((res) => res.json());
    assert.ok(r.searched.includes('brain'), 'search hit the available store');
    assert.ok(r.results.some((x) => x.ref === 'rag' && x.source === 'brain'), 'returns the brain note');
    assert.ok(r.tokens <= 2600, 'respects the token budget');

    const only = await fetch(base + '/api/search?q=retrieval&only=reading').then((res) => res.json());
    assert.ok(!only.searched.includes('brain'), 'only= restricts which stores are queried');

    const stats = await fetch(base + '/api/stats').then((res) => res.json());
    assert.equal(stats.stores, 4);
    assert.ok(stats.available >= 1 && stats.entries >= 1, 'stats summarises live stores');
  } finally { server.close(); }
});
