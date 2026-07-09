#!/usr/bin/env node
// recall CLI — one query across your whole memory (cortex + scout + lens).
//   recall "<query>" [-k 10] [--tokens 2000] [--only brain,code]
//   recall status
import * as r from './core.js';

const [, , cmd, ...rest] = process.argv;
const VALUE = new Set(['-k', '--tokens', '--only']);
const positionals = []; const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('-')) positionals.push(a);
  else if (VALUE.has(a)) flags[a] = rest[++i];
  else flags[a] = true;
}
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const SIGIL = { brain: '🧠', reading: '🧭', code: '🔎' };

try {
  if (cmd === 'status') {
    out(r.status());
  } else if (cmd && cmd !== 'help' && cmd !== '--help') {
    const query = [cmd, ...positionals].join(' ');
    const res = r.recall(query, { k: +(flags['-k'] || 10), max_tokens: +(flags['--tokens'] || 2000),
      sources: flags['--only'] ? flags['--only'].split(',') : undefined });
    if (!res.searched?.length) { out('no knowledge stores found — set CORTEX_VAULT / SCOUT_DB / LENS_DB, or run from a dir that has them.'); process.exit(0); }
    for (const x of res.results)
      out(`\n${SIGIL[x.source] || '•'} [${x.source}] ${x.title}  (${x.ref})  score=${x.score}\n  ${x.excerpt}`);
    out(`\n— ${res.count} hits across [${res.searched.join(', ')}], ~${res.tokens} tokens —`);
  } else {
    out(`recall — one query across your whole memory (cortex + scout + lens)

  recall "<query>" [-k N] [--tokens N] [--only brain,reading,code]
  recall status                         which knowledge stores are available

  Stores (auto-discovered, all optional):
    🧠 brain    cortex notes   ($CORTEX_VAULT/.cortex/index.db  or  $RECALL_CORTEX_DB)
    🧭 reading  scout pages     ($SCOUT_DB  or  $RECALL_SCOUT_DB)
    🔎 code     lens chunks     ($LENS_DB   or  $RECALL_LENS_DB)`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
