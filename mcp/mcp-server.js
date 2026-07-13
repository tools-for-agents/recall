#!/usr/bin/env node
// recall — MCP server (stdio JSON-RPC). One tool call that searches an agent's
// whole memory at once — its second brain (cortex), what it has read (scout) and
// its code (lens) — and returns a single token-budgeted briefing. Run it at the
// start of a task to load exactly the relevant context instead of searching each
// store by hand. Read-only over the sibling tools' indexes.
import { createInterface } from 'node:readline';
import * as r from '../src/core.js';

const PROTOCOL = '2024-11-05';

const tools = [
  {
    name: 'recall_search',
    description: 'Recall everything relevant to a query across ALL your knowledge at once: your second brain (cortex notes), the team\'s shared memory (agent-hq), your reading history (scout pages) and your code (lens). Returns one ranked, token-budgeted briefing with each hit tagged by source. Use this FIRST when starting a task — it loads the right context so you don\'t re-derive what you already know or re-read the web.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' },
      k: { type: 'integer', description: 'Max total results (default 10)' },
      max_tokens: { type: 'integer', description: 'Token budget for the briefing (default 2000)' },
      sources: { type: 'array', items: { type: 'string', enum: ['brain', 'team', 'reading', 'code'] },
        description: 'Restrict to specific stores (default: all available)' },
    }, required: ['query'] },
    run: (a) => r.recall(a.query, a),
  },
  {
    name: 'recall_expand',
    description: 'Get the FULLER context behind a single recall_search hit — the whole note, page or code chunk it came from, read straight from the source store (capped). A recall_search excerpt is a preview; when one hit is the one you need, expand it here instead of switching to cortex_read / scout_fetch / lens_read and having to know which store it lives in. Pass the hit\'s `source` and `ref` exactly as recall_search returned them.',
    inputSchema: { type: 'object', properties: {
      source: { type: 'string', enum: ['brain', 'team', 'reading', 'code'],
        description: 'Which store the hit came from (the `source` field on a recall_search result)' },
      ref: { type: 'string', description: 'The hit\'s `ref` (a note slug, a page url, or a code path:line)' },
    }, required: ['source', 'ref'] },
    run: (a) => r.expand(a.source, a.ref),
  },
  {
    name: 'recall_status',
    description: 'Show which knowledge stores are available and how many entries each holds (cortex / agent-hq / scout / lens).',
    inputSchema: { type: 'object', properties: {} },
    run: () => r.status(),
  },
];

// ── What each tool does to the world ───────────────────────────────────────────
// MCP tool annotations (spec 2025-11-25). The spec's defaults are PESSIMISTIC: with no
// annotations at all, every tool here — including the pure reads — is declared
// destructive and open-world, and a conformant client should warn before each call.
// You do not become safe by omission. You become safe by saying so.
//
//   readOnlyHint    the tool changes nothing        → the client can skip the confirmation
//   destructiveHint it may overwrite or delete      → the client should warn first
//   idempotentHint  calling twice changes no more   → safe to retry on failure
//   openWorldHint   it reaches, or returns content from, outside our trust boundary
//                   (the web; the output of arbitrary code) → scrutinise what comes back
const ANNOTATIONS = {
  recall_search: {"readOnlyHint": true, "openWorldHint": true},
  recall_expand: {"readOnlyHint": true, "openWorldHint": true},
  recall_status: {"readOnlyHint": true, "openWorldHint": false},
};

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: 'recall', version: '0.1.0' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list')
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: ANNOTATIONS[name] })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    // Every tool DECLARES its required arguments in inputSchema, and nothing enforced
    // them. `lens_search` with no query did not say "query is required" — it called
    // search(undefined) and died three layers down with
    //     Cannot read properties of undefined (reading 'match')
    // which is what a model got back, as if it were an answer. A schema that promises a
    // check nobody performs is worse than no schema: the client trusts it.
    const args = params?.arguments || {};
    const missing = (tool.inputSchema?.required || [])
      .filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      const how = missing
        .map((k) => `"${k}"${tool.inputSchema.properties?.[k]?.description ? ` (${tool.inputSchema.properties[k].description})` : ''}`)
        .join(', ');
      return fail(id, -32602, `${tool.name}: missing required argument${missing.length > 1 ? 's' : ''} ${how}`);
    }
    // ...and the TYPES it declares, and the enums. Nothing enforced those either, and
    // unlike a missing argument they do not crash — they corrupt, quietly:
    //   kanban_create_task labels:"urgent"   → a task whose labels are the letters u,r,g…
    //   cortex_write title:{...}             → a note on disk called "[object Object]"
    //   lens_search k:"eight"                → silently ignored, and you never learn why
    // Wrong data written confidently is worse than an error, because nothing announces it.
    const props = tool.inputSchema?.properties || {};
    const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    const OK = {
      string: (v) => typeof v === 'string',
      number: (v) => typeof v === 'number' && Number.isFinite(v),
      integer: (v) => Number.isInteger(v),
      boolean: (v) => typeof v === 'boolean',
      array: (v) => Array.isArray(v),
      object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    };
    const wrong = [];
    for (const [k, spec] of Object.entries(props)) {
      const v = args[k];
      if (v === undefined || v === null) continue;
      if (spec.type && OK[spec.type] && !OK[spec.type](v)) {
        wrong.push(`"${k}" must be ${spec.type}, got ${kindOf(v)}`);
      } else if (spec.enum && !spec.enum.includes(v)) {
        wrong.push(`"${k}" must be one of ${spec.enum.join(' | ')} — got ${JSON.stringify(v)}`);
      }
    }
    if (wrong.length) return fail(id, -32602, `${tool.name}: ${wrong.join('; ')}`);
    try {
      const result = await tool.run(args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e)); });
});
process.stderr.write('recall MCP server ready\n');
