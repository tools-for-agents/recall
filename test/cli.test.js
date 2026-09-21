// THE CLI IS WHERE THE BRIEFING IS ACTUALLY READ, AND NOTHING HAD EVER RUN IT.
//
// Every other test in this suite calls `recall()` and inspects the object. But an agent — and a
// person — reads `node src/cli.js "…"`, and between the object and the screen sits a printer that
// can drop any part of it. It dropped the most important part: the failure report.
//
// `if (!res.searched?.length) { out('no knowledge stores found — set CORTEX_VAULT / SCOUT_DB /
// LENS_DB…'); process.exit(0); }` answered THREE different situations with one sentence. When the
// only store was `team` and agent-hq answered HTTP 500 — `--only team`, or simply any run from a
// directory that is not a lens-indexed repo with a cortex vault, since the local store paths default
// to ./vault/.cortex/index.db and friends — core computed
//     failed: { team: 'HTTP 500 from …/api/memory — agent-hq is up but its memory API is failing' }
// and this line threw it away, printing a confident diagnosis that names the three stores which are
// NOT the problem and never mentions agent-hq, HQ_URL or the 500. The ✗ COULD NOT BE SEARCHED block
// — the entire reason the failure path exists — was unreachable on that path.
//
// The suite missed it because every test that exercises a broken store also has a healthy brain on
// disk, which keeps `searched` non-empty. The bug lives in the shape nothing tested: no local store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');
const dir = mkdtempSync(join(tmpdir(), 'recall-cli-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

// Run the real CLI the way a user does, in a directory with NO stores in it, and read what it
// printed. spawn (not spawnSync) on purpose: the fake agent-hq lives in THIS process's event loop,
// and spawnSync would block it — the child's probe would hang and every case would "fail" for a
// reason that has nothing to do with the code under test.
const runCli = (args, env) => new Promise((done) => {
  const p = spawn(process.execPath, [CLI, ...args], {
    cwd: dir,                                   // no ./vault, ./.scout or ./.lens here
    env: { ...process.env,
      RECALL_CORTEX_DB: join(dir, 'absent-brain.db'),
      RECALL_SCOUT_DB: join(dir, 'absent-scout.db'),
      RECALL_LENS_DB: join(dir, 'absent-lens.db'),
      CORTEX_VAULT: '', SCOUT_DB: '', LENS_DB: '', HQ_URL: '', ...env },
  });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => done({ out, err, code }));
});

test('the CLI never swallows the failure report — "nothing searched" is not "no stores configured"', async (t) => {
  let mode = '500';
  const hq = createServer((req, res) => {
    const J = { 'content-type': 'application/json' };
    if (mode === '500') { res.writeHead(500, J); return res.end('{"error":"database is locked"}'); }
    res.writeHead(200, J);
    res.end(JSON.stringify([{ id: 'm-budget', title: 'Token budget is mandatory', namespace: 'decisions',
      content: 'Every retrieval call must carry a token budget.', importance: 5 }]));
  });
  await new Promise((r) => hq.listen(0, '127.0.0.1', r));
  t.after(() => { hq.closeAllConnections?.(); hq.close(); });
  const base = `http://127.0.0.1:${hq.address().port}`;
  await fetch(`${base}/api/memory?limit=1`).catch(() => {});   // warm the origin; see recall.test.js

  // A probe that times out is a DIFFERENT sentinel (the platform never answered), so a cold start
  // would quietly test something else. Re-run until the platform demonstrably answered; if it never
  // does, the assertion below reports the real output rather than a retry count.
  const cli = async (args, env) => {
    let r;
    for (let i = 0; i < 5; i++) { r = await runCli(args, env); if (/COULD NOT BE SEARCHED/.test(r.out)) break; }
    return r;
  };

  // 1. --only team, documented in --help, against an agent-hq that is up and broken.
  const only = await cli(['retrieval budget', '--only', 'team'], { RECALL_HQ_URL: base });
  assert.match(only.out, /✗ team COULD NOT BE SEARCHED/,
    `the CLI must print the failure report it was handed — got:\n${only.out}`);
  assert.match(only.out, /HTTP 500/, 'naming what agent-hq actually answered');
  assert.match(only.out, /api\/memory/, 'and where it looked');
  assert.match(only.out, /INCOMPLETE/, 'and that the briefing above cannot be trusted as complete');
  assert.doesNotMatch(only.out, /no knowledge stores found/,
    'agent-hq WAS found, WAS reached and answered 500 — telling the reader to set CORTEX_VAULT is a '
    + 'confident wrong diagnosis of a machine whose only problem is the one store recall did reach');

  // 2. The same thing without --only: the everyday case, a run from a directory with no local store.
  const plain = await cli(['retrieval budget'], { RECALL_HQ_URL: base });
  assert.match(plain.out, /✗ team COULD NOT BE SEARCHED/, `no --only, same duty — got:\n${plain.out}`);
  assert.doesNotMatch(plain.out, /no knowledge stores found/, 'and the same wrong sentence must not appear');

  // 3. OVER-FIRE GUARD — the original sentence is still right when it IS right. Nothing on disk and
  //    nothing listening: no store was reached, none broke, and "set CORTEX_VAULT" is the fix.
  //    (port 9 is what the rest of this suite uses for "nothing there": fetch refuses it outright,
  //    so it cannot accidentally reach whatever a developer happens to have listening.)
  const bare = await runCli(['retrieval budget'], { RECALL_HQ_URL: 'http://127.0.0.1:9' });
  assert.match(bare.out, /no knowledge stores found/,
    `with no stores AND no platform, the setup hint is the honest answer — got:\n${bare.out}`);
  assert.doesNotMatch(bare.out, /COULD NOT BE SEARCHED/, 'and nothing broke, so nothing may cry wolf');

  // 4. A query with nothing searchable in it is a fact about the QUERY. core never reaches a store
  //    (it returns before `searched` exists), and blaming the user's store configuration for that is
  //    the same wrong-diagnosis class one line over.
  mode = 'ok';
  const junk = await runCli(['???'], { RECALL_HQ_URL: base });
  assert.match(junk.out, /nothing searchable/i, `"???" is a query problem — got:\n${junk.out}`);
  assert.doesNotMatch(junk.out, /no knowledge stores found/, 'the stores are fine; they were never asked');

  // 5. …and a healthy run still prints a briefing, so none of the above is guarding a dead path.
  const good = await cli(['retrieval budget'], { RECALL_HQ_URL: base });
  assert.match(good.out, /\[team\] Token budget is mandatory/, `a healthy agent-hq still briefs — got:\n${good.out}`);
  assert.match(good.out, /hits across \[team\]/, 'and says which store it asked');
  assert.doesNotMatch(good.out, /COULD NOT BE SEARCHED/, 'with nothing broken, no failure block');
  assert.equal(good.err, '', 'and nothing on stderr');
});
