#!/usr/bin/env node
// Seed the three sibling stores recall federates, so `recall serve` shows a real
// briefing — and so CI can LOOK at a console with something in it.
//
//   node scripts/seed.js ./.recall-seed
//   RECALL_CORTEX_DB=./.recall-seed/brain.db \
//   RECALL_SCOUT_DB=./.recall-seed/reading.db \
//   RECALL_LENS_DB=./.recall-seed/code.db  node src/cli.js serve
//
// Why this exists: the CI gate was pointing iris at an EMPTY console. recall federates
// stores it does not own, so with no siblings installed it correctly finds nothing,
// renders nothing, and passes every check — because there is nothing on the page to be
// wrong. An empty page cannot overflow, collide or clip. A UI gate that has never seen
// a row of data is not a gate.
//
// recall reads its siblings read-only, by their table shapes — so a faithful fake is a
// faithful fake. Deterministic; no network, no Docker, no siblings required.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || './.recall-seed');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

/* ── brain: a cortex vault (notes + notes_fts) ─────────────────────────────── */
const brain = new DatabaseSync(join(dir, 'brain.db'));
brain.exec(`CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, body TEXT);
  CREATE VIRTUAL TABLE notes_fts USING fts5(slug UNINDEXED, title, tags, body, tokenize='porter unicode61');`);
const NOTES = [
  ['retrieval-budget', 'Retrieval on a token budget', 'concept', 'agents',
   'An agent should pull just enough context, never a whole file. Retrieval fills to a budget and stops; what it withheld it says out loud, because a silent truncation reads as completeness.'],
  ['the-eye', 'An agent that never looks is designing blind', 'concept', 'design',
   'A model writing CSS emits rules and never sees the page. The fix is not more taste, it is feedback: render it, and hand the pixels back to the model.'],
  ['fewer-decisions', 'Good design is fewer decisions', 'concept', 'design',
   'A designer picks a type scale and a spacing grid, and everything obeys. A model writing CSS a rule at a time cannot remember what it chose ten lines ago. It does not have to, if the answer is in a file.'],
  ['second-brain', 'Files are the truth, the index is derived', 'concept', 'memory',
   'Notes are plain markdown you own. The search index is rebuildable from them, so it can never be the thing you lose.'],
];
for (const [slug, title, type, tags, body] of NOTES) {
  brain.prepare('INSERT INTO notes VALUES (?,?,?,?)').run(slug, title, type, body);
  brain.prepare('INSERT INTO notes_fts (slug,title,tags,body) VALUES (?,?,?,?)').run(slug, title, tags, body);
}
brain.close();

/* ── reading: a scout cache (pages + pages_fts) ────────────────────────────── */
const reading = new DatabaseSync(join(dir, 'reading.db'));
reading.exec(`CREATE TABLE pages (url TEXT PRIMARY KEY, title TEXT, markdown TEXT);
  CREATE VIRTUAL TABLE pages_fts USING fts5(url UNINDEXED, title, body, tokenize='porter unicode61');`);
const PAGES = [
  ['https://llmstxt.org/', 'The /llms.txt file',
   'A proposal for a markdown file at the root of a site that gives a language model a curated map of it, instead of asking it to read the navigation chrome of every page.'],
  ['https://modelcontextprotocol.io/', 'Model Context Protocol',
   'An open protocol for connecting models to tools and data over a small JSON-RPC surface: tools/list tells a client what it can call, and tools/call runs it.'],
  ['https://www.w3.org/TR/WCAG21/', 'WCAG 2.1 contrast',
   'Body text needs 4.5:1 against its background and large text needs 3:1. Measured against the effective backdrop, not the colour someone declared and never painted.'],
];
for (const [url, title, body] of PAGES) {
  reading.prepare('INSERT INTO pages VALUES (?,?,?)').run(url, title, body);
  reading.prepare('INSERT INTO pages_fts (url,title,body) VALUES (?,?,?)').run(url, title, body);
}
reading.close();

/* ── code: a lens index (chunks) ───────────────────────────────────────────── */
const code = new DatabaseSync(join(dir, 'code.db'));
code.exec(`CREATE VIRTUAL TABLE chunks USING fts5(path UNINDEXED, body, lang UNINDEXED, start UNINDEXED, tokenize='porter unicode61');`);
const CHUNKS = [
  ['src/core.js', 'js', 12, 'export async function recall(query, opts) { const stores = available(); return interleave(stores, query, opts.max_tokens); }'],
  ['src/audit.js', 'js', 205, 'function backdrop(el) { for (let n = el; n; n = n.parentElement) { const c = bgOf(n); if (c && c.a >= 0.999) return c; } }'],
  ['src/budget.js', 'js', 40, 'function fill(results, budget) { let used = 0; const out = []; for (const r of results) { if (used + cost(r) > budget) break; out.push(r); used += cost(r); } return out; }'],
];
for (const [path, lang, start, body] of CHUNKS) {
  code.prepare('INSERT INTO chunks (path,body,lang,start) VALUES (?,?,?,?)').run(path, body, lang, start);
}
code.close();

console.log(`✓ seeded ${dir}`);
console.log(`  brain   ${NOTES.length} notes`);
console.log(`  reading ${PAGES.length} pages`);
console.log(`  code    ${CHUNKS.length} chunks`);
console.log(`\n  RECALL_CORTEX_DB=${join(dir, 'brain.db')} \\`);
console.log(`  RECALL_SCOUT_DB=${join(dir, 'reading.db')} \\`);
console.log(`  RECALL_LENS_DB=${join(dir, 'code.db')} node src/cli.js serve`);
