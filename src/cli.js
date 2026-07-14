#!/usr/bin/env node
// recall CLI — one query across your whole memory (cortex + scout + lens).
//   recall "<query>" [-k 10] [--tokens 2000] [--only brain,code]
//   recall status
//   recall serve [--port 7980]
import * as r from './core.js';

const [, , cmd, ...rest] = process.argv;
const VALUE = new Set(['-k', '--tokens', '--only', '--port']);
const positionals = []; const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('-')) positionals.push(a);
  else if (VALUE.has(a)) flags[a] = rest[++i];
  else flags[a] = true;
}
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const SIGIL = { brain: '🧠', team: '🛰️', reading: '🧭', code: '🔎' };

try {
  if (cmd === 'status') {
    out(await r.status());
  } else if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    serve({ port: +(flags['--port'] || process.env.RECALL_PORT || 7980) });
  } else if (cmd === 'mcp') {
    // stdio JSON-RPC. The server starts on import: `npx @tools-for-agents/recall mcp`
    // NOTE: must come BEFORE the catch-all below, which treats any word as a query.
    await import('../mcp/mcp-server.js');
  } else if (cmd && cmd !== 'help' && cmd !== '--help') {
    const query = [cmd, ...positionals].join(' ');
    const res = await r.recall(query, { k: +(flags['-k'] || 10), max_tokens: +(flags['--tokens'] || 2000),
      sources: flags['--only'] ? flags['--only'].split(',') : undefined });
    if (!res.searched?.length) { out('no knowledge stores found — set CORTEX_VAULT / SCOUT_DB / LENS_DB, or run from a dir that has them.'); process.exit(0); }
    for (const x of res.results)
      out(`\n${SIGIL[x.source] || '•'} [${x.source}] ${x.title}  (${x.ref})  score=${x.score}\n  ${x.excerpt}`);
    out(`\n— ${res.count} hits across [${res.searched.join(', ')}], ~${res.tokens} tokens —`);
    // 🔑 A STORE THAT FAILED IS NOT A STORE WITH NO RESULTS. It used to be swallowed and counted as
    // searched-and-empty, so the briefing said "searched code · 0 matched · 1 entry" — which reads as
    // "your code index has a file and your term is NOT in it." It has to be louder than an empty store,
    // because a store that is empty is a fact about the world; a store that BROKE is a fact about the
    // tool, and only one of them means the answer above is incomplete.
    if (res.failed) {
      for (const [name, why] of Object.entries(res.failed)) {
        out(`  ✗ ${name} COULD NOT BE SEARCHED — ${why}\n`
          + `    This is NOT "nothing matched there". That store contributed NOTHING to the briefing above,\n`
          + `    so treat these results as INCOMPLETE until it is fixed.`);
      }
    }
    // An empty store is not a finding. Say so before the agent concludes it knows nothing.
    if (res.empty?.length) {
      const all = res.empty.length === res.searched.length;
      const list = res.empty.length > 1
        ? res.empty.slice(0, -1).join(', ') + ' and ' + res.empty.at(-1)
        : res.empty[0];
      out(`  ⚠ ${list} ${res.empty.length === 1 ? 'is' : 'are'} EMPTY (0 entries)`
        + (all ? ` — every store you pointed me at holds nothing. This is not "you know nothing about that";\n    it is "there is nothing here to know it from". Check CORTEX_VAULT / SCOUT_DB / LENS_DB.` : ''));
    }
    // Never let a ceiling hide a store without saying so. A briefing that showed
    // 10 of 32 must not look like a briefing that found 10.
    if (res.withheld) {
      const per = Object.entries(res.stores).filter(([, v]) => v.withheld)
        .map(([s, v]) => `${s} ${v.shown}/${v.matched}`).join(', ');
      out(`  ${res.withheld} more matched and are not shown (${per})`);
      out(res.limited_by === 'budget'
        ? `  the token budget bound — raise it with --tokens ${res.budget * 2}`
        : `  the result cap bound — raise it with -k ${res.k * 2}`);
      if (res.silent.length) out(`  ⚠ ${res.silent.join(', ')} matched but showed nothing — invisible here, not empty`);
    }
  } else {
    out(`recall — one query across your whole memory (cortex + scout + lens)

  recall "<query>" [-k N] [--tokens N] [--only brain,team,reading,code]
  recall status                         which knowledge stores are available

  Stores (auto-discovered, all optional):
    🧠 brain    cortex notes    ($CORTEX_VAULT/.cortex/index.db  or  $RECALL_CORTEX_DB)
    🛰️ team     agent-hq memory ($HQ_URL  or  $RECALL_HQ_URL, default http://localhost:7700)
    🧭 reading  scout pages      ($SCOUT_DB  or  $RECALL_SCOUT_DB)
    🔎 code     lens chunks      ($LENS_DB   or  $RECALL_LENS_DB)`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
