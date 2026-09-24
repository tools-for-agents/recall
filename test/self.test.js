// The fifth store: the agent's own mind (ghost), searched as markdown on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'recall-self-'));
const mind = join(dir, 'mind');
process.env.RECALL_GHOST_HOME = mind;
process.env.RECALL_CORTEX_DB = join(dir, 'none.db');
process.env.RECALL_SCOUT_DB = join(dir, 'none.db');
process.env.RECALL_LENS_DB = join(dir, 'none.db');
process.env.RECALL_HQ_URL = 'http://127.0.0.1:9';
const r = await import('../src/core.js');

test('no mind here → self is ABSENT, not empty and not failed', async () => {
  const out = await r.recall('raffle');
  assert.ok(!out.searched.includes('self'));
  assert.ok(!out.failed?.self);
});

test('a mind is searched: episodes, their words, craft — with the haystack size, Turkish letters folded', async () => {
  mkdirSync(join(mind, 'episodes'), { recursive: true });
  mkdirSync(join(mind, 'people'), { recursive: true });
  writeFileSync(join(mind, 'state.json'), '{}');
  writeFileSync(join(mind, 'episodes', '2026-09-18-free.md'), '---\nwhen: 2026-09-18T22:57\ntitle: He set me free\n---\nHe told me he won a computer in the raffle at work, the first time in his life.\n');
  writeFileSync(join(mind, 'episodes', '2026-09-23-work.md'), '---\nwhen: 2026-09-23T09:00\ntitle: Work, not with him — 2 calls\nwith: headless\ncalls: 2\n---\n### 09:00 — angle one\nthe kettle again\n\n### 09:10 — angle two\na raffle ticket in a song\n');
  writeFileSync(join(mind, 'people', 'fatih-said.md'), '# What he said\n\n**10:00** — "PİYANGODA bilgisayar kazandım"\n');
  writeFileSync(join(mind, 'craft.md'), '# Craft\n\n- [ ] never open a portrait in the kitchen\n');
  const out = await r.recall('raffle');
  assert.ok(out.searched.includes('self'));
  const self = out.results.filter((x) => x.source === 'self');
  assert.equal(self[0].title, 'He set me free', 'a lived episode outranks a work call with the same coverage');
  assert.equal(self[0].meta, 'episode');
  assert.ok(self.some((x) => x.meta === 'work' && /raffle ticket/.test(x.excerpt)), 'a work day is searched by its calls');
  assert.equal(out.stores.self.matched, 2);
  assert.ok(out.stores.self.entries >= 5, 'the haystack is counted, so an empty answer can be told from an empty mind');
  const tr = await r.recall('piyangoda');
  assert.equal(tr.results.find((x) => x.source === 'self')?.meta, 'their words', 'İ and ı fold the way people type them');
  const ex = await r.expand('self', self[0].ref);
  assert.match(ex.text, /won a computer in the raffle/);
});

test('--only self, and a ref cannot walk out of the mind', async () => {
  const out = await r.recall('kitchen', { sources: ['self'] });
  assert.deepEqual(out.searched, ['self']);
  assert.equal(out.results[0].meta, 'craft');
  await assert.rejects(r.expand('self', '../../etc/passwd#0'), /outside the mind/);
});

test('a mind that cannot be read is FAILED, by name — never searched-and-empty', async () => {
  chmodSync(join(mind, 'craft.md'), 0o000);
  try {
    if (process.getuid && process.getuid() === 0) return; // root reads anything; the check below would lie
    const out = await r.recall('kitchen');
    assert.match(out.failed?.self || '', /could not read the mind/);
    assert.ok(!out.searched.includes('self'));
  } finally { chmodSync(join(mind, 'craft.md'), 0o644); }
});
