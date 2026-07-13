// CAN THE TEST SUITE STILL FAIL?
//
// Every other gate here asks "is the code right". This one asks the question underneath it:
// IS ANYTHING STILL WATCHING. A suite that has quietly stopped covering a property goes green
// for exactly the same reason as a suite that is passing honestly, and there is no way to tell
// the two apart by looking at the green.
//
// It has happened across this kit more than once. anvil's Docker tests were SKIPPED for months
// — 11 pass, 0 fail, 9 skipped, green every run — while the tool was completely broken on
// Linux. lens's file walk swallowed .env files, and twenty green tests never saw it.
//
// So: break the code ON PURPOSE, in the exact places whose breakage would cost the most, and
// demand the suite goes RED. If it stays green, the canary is dead and this job fails — the
// test guarding that line has stopped guarding it, and you find out today rather than the
// morning after it mattered.
//
//   node scripts/mutants.mjs
//
// Each canary must have EXACTLY ONE anchor. An anchor that has drifted is a canary that
// silently stopped watching, so a missing or ambiguous anchor is a hard failure, never a skip.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
  {
    why: 'the token budget is a CEILING — a briefing that blows it defeats the entire point of recall',
    file: 'src/core.js',
    find: '      if (tokens + tk <= max_tokens || results.length === 0) { results.push({ ...hit, tokens: tk }); tokens += tk; }',
    into: '      if (true) { results.push({ ...hit, tokens: tk }); tokens += tk; }',
  },
  {
    why: 'k is a ceiling too — "give me 3" must not hand back 30',
    file: 'src/core.js',
    find: '  for (let i = 0; results.length < k; i++) {',
    into: '  for (let i = 0; i < 1e6; i++) {',
  },
  {
    why: 'what the budget squeezed out is COUNTED and owned up to — silence reads as "there was nothing else"',
    file: 'src/core.js',
    find: '      else squeezed++;      // it matched; the budget is the only reason you can\'t see it',
    into: '      else void 0;',
  },
  {
    why: 'the briefing must be RANKED — the budget does not reorder a bad ranking, it DELETES what the ranking put last',
    file: 'src/core.js',
    find: '  for (const s in bySource) bySource[s].sort((a, b) => a.score - b.score);',
    into: '  for (const s in bySource) bySource[s].sort((a, b) => a.score + b.score);',
  },
  {
    why: 'expand means GIVE ME EXACTLY THIS RECORD — handing back the one next to it is the confident wrong answer in its purest form',
    file: 'src/core.js',
    find: 'rows.find((x) => x.id === ref)',
    into: 'rows.find((x) => x.id !== ref)',
  },
  {
    why: 'the team store defaults to OFFLINE — recall must not claim a store is live when agent-hq is down',
    file: 'src/core.js',
    find: "  let team = { store: 'team', tool: 'agent-hq', source: hqUrl(), web: hqUrl(), available: false, entries: null };",
    into: "  let team = { store: 'team', tool: 'agent-hq', source: hqUrl(), web: hqUrl(), available: true, entries: null };",
  },
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT,
// not a test failure. Reading that as "the suite is already red" turns a slow suite into a broken
// one. Distinguish them: a suite that never finished has not answered, and a mutant that makes the
// suite hang has not been "killed". (Only iris is slow enough to hit this, but the bug was latent
// in every copy of this helper.)
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' };
};

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
console.log('baseline: green\n');

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  writeFileSync(c.file, orig);

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}\n  Nothing is guarding that line any more.`);
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
