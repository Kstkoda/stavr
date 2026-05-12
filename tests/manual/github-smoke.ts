/* eslint-disable no-console */
// Manual smoke test for the GitHub adapter. Requires `gh auth status` to be
// authenticated on the host. Hits real GitHub via the gh CLI.
//
// Run: npx tsx tests/manual/github-smoke.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerGithubTools } from '../../src/adapters/github.js';

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  if (res.isError) {
    throw new Error(`${name} errored: ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const server = new McpServer({ name: 'gh-smoke', version: '0.0.0' });
  registerGithubTools(server);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'gh-smoke-client', version: '0.0.0' });
  await client.connect(clientT);

  const repo = 'Kstkoda/privacy-tracker';

  console.log(`\n--- github.read_pr ${repo}#14 ---`);
  const pr = await call(client, 'github.read_pr', { repo, number: 14 });
  console.log(`title: ${pr.title}`);
  console.log(`state: ${pr.state}`);

  console.log(`\n--- github.list_prs ${repo} state=open limit=5 ---`);
  const list = await call(client, 'github.list_prs', { repo, state: 'open', limit: 5 });
  console.log(`count: ${list.prs.length}`);
  for (const p of list.prs) {
    console.log(`  #${p.number} ${p.title}`);
  }

  await client.close();
  await server.close();
  console.log('\nsmoke OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
