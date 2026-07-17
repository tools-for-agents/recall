// recall ordering test — the federated search queries each sibling store's FTS directly and orders
// by bm25 score, which is not unique: two notes with the same content score identically, and ORDER
// BY a tie falls back to rowid, which changes when the underlying store re-inserts a row (a re-sync,
// a forget-and-refetch). Each store query tie-breaks on the row's stable key — here, a note's slug.
// Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'recall-order-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const brainDb = join(dir, 'brain.db');
const BODY = 'Retrieval augmented generation fetches relevant zqxchunks for the model.';

function buildBrain() {
  const db = new DatabaseSync(brainDb);
  db.exec(`DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS notes_fts;
    CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT);
    CREATE VIRTUAL TABLE notes_fts USING fts5(slug UNINDEXED, title, tags, body, tokenize='porter');`);
  // Two notes, IDENTICAL body → identical bm25 for a query that matches. INSERTED IN REVERSE slug
  // order (zzz first) ON PURPOSE: the order a store happens to insert its rows is arbitrary — file
  // discovery order, sync order — and must NOT leak into the result order. Without a tie-break, it
  // does: a bare ORDER BY score returns the tie in rowid (= insertion) order, zzz then aaa.
  for (const slug of ['zzz', 'aaa']) {
    db.prepare('INSERT INTO notes VALUES (?,?,?)').run(slug, slug.toUpperCase(), 'concept');
    db.prepare('INSERT INTO notes_fts (slug,title,tags,body) VALUES (?,?,?,?)').run(slug, slug.toUpperCase(), 'ml', BODY);
  }
  db.close();
}
buildBrain();

process.env.RECALL_CORTEX_DB = brainDb;
process.env.RECALL_SCOUT_DB = join(dir, 'absent-scout.db');
process.env.RECALL_LENS_DB = join(dir, 'absent-lens.db');
process.env.RECALL_HQ_URL = 'http://127.0.0.1:9';   // unreachable → the team store degrades out

const { recall } = await import('../src/core.js');

const brainRefs = async () => (await recall('zqxchunks', { k: 10 })).results
  .filter((r) => r.source === 'brain' || r.meta === 'concept')
  .map((r) => r.ref);

test('score-tied federated hits order by the row key, not by the store\'s insertion order', async () => {
  // slug order, though the store inserted them zzz-first. Without the tie-break this comes back
  // zzz, aaa — the store's arbitrary insertion order leaking into recall's briefing.
  assert.deepEqual(await brainRefs(), ['aaa', 'zzz'],
    `tied hits must order by slug regardless of how the store inserted them — got ${await brainRefs()}`);
});
