// The seed feeds the UI gates. If its stores do not match the schemas the real tools create, recall's
// queries fail on them and every gate that serves the seed grades a briefing with stores broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'recall-seed-'));
spawnSync(process.execPath, [new URL('../scripts/seed.js', import.meta.url).pathname, dir], { encoding: 'utf8' });
process.env.RECALL_CORTEX_DB = join(dir, 'brain.db');
process.env.RECALL_SCOUT_DB = join(dir, 'reading.db');
process.env.RECALL_LENS_DB = join(dir, 'code.db');
process.env.RECALL_GHOST_HOME = join(dir, 'no-mind');
process.env.RECALL_HQ_URL = 'http://127.0.0.1:9';
const r = await import('../src/core.js');

test('every store the seed builds is one recall can actually query', async () => {
  const s = await r.status();
  for (const name of ['brain', 'reading', 'code']) {
    const st = s.stores.find((x) => x.store === name);
    assert.equal(st.available, true, `${name}: ${st.error || 'not available'}`);
    assert.ok(st.entries > 0, `${name} is empty`);
  }
  const out = await r.recall('model contrast budget notes');
  assert.equal(out.failed, undefined, `a seeded store failed its query: ${JSON.stringify(out.failed)}`);
  for (const name of ['brain', 'reading', 'code']) assert.ok(out.searched.includes(name), `${name} was not searched`);
});
