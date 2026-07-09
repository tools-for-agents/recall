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
    description: 'Recall everything relevant to a query across ALL your knowledge at once: your second brain (cortex notes), your reading history (scout pages) and your code (lens). Returns one ranked, token-budgeted briefing with each hit tagged by source. Use this FIRST when starting a task — it loads the right context so you don\'t re-derive what you already know or re-read the web.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' },
      k: { type: 'integer', description: 'Max total results (default 10)' },
      max_tokens: { type: 'integer', description: 'Token budget for the briefing (default 2000)' },
      sources: { type: 'array', items: { type: 'string', enum: ['brain', 'reading', 'code'] },
        description: 'Restrict to specific stores (default: all available)' },
    }, required: ['query'] },
    run: (a) => r.recall(a.query, a),
  },
  {
    name: 'recall_status',
    description: 'Show which knowledge stores are available and how many entries each holds (cortex / scout / lens).',
    inputSchema: { type: 'object', properties: {} },
    run: () => r.status(),
  },
];

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
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const result = await tool.run(params.arguments || {});
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
