import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { Command } from 'commander';
import { EventStore } from '../persistence.js';
import { loadMasterKey } from './vault.js';
import { CredentialStore } from './store.js';

/**
 * Spec 48 Layer 2 — `stavr connect <service>` + `stavr credentials list/revoke`.
 *
 * `stavr connect github` runs the OAuth code-flow against a registered GitHub
 * App. The User must supply STAVR_GITHUB_CLIENT_ID and STAVR_GITHUB_CLIENT_SECRET
 * (App ownership is the User's responsibility). We never ship public secrets.
 *
 * `stavr connect anthropic --key sk-ant-...` is the API-key path: no OAuth
 * dance, the key goes straight to the vault. Never echoed back; reads from
 * argv to be a stable interface (stdin-only would complicate scripted setup).
 */
export function registerCredentialsCli(program: Command, defaultDbPath: () => string): void {
  const connect = program.command('connect').description('Connect upstream services to the credential vault.');

  connect
    .command('github')
    .description('Connect a GitHub App via OAuth code flow. Requires STAVR_GITHUB_CLIENT_ID + STAVR_GITHUB_CLIENT_SECRET in env.')
    .option('--user-id <id>', 'User identifier', 'default-user')
    .option('--scopes <s>', 'Comma-separated OAuth scopes', 'repo,read:user')
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .option('--no-open', 'Print the auth URL but don\'t open the browser.')
    .action(async (opts: { userId: string; scopes: string; db: string; open: boolean }) => {
      const clientId = process.env.STAVR_GITHUB_CLIENT_ID;
      const clientSecret = process.env.STAVR_GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        console.error(
          JSON.stringify(
            {
              ok: false,
              code: 'GH_OAUTH_NOT_CONFIGURED',
              message:
                'STAVR_GITHUB_CLIENT_ID + STAVR_GITHUB_CLIENT_SECRET must be set. Register a GitHub App at https://github.com/settings/apps and add a callback to http://127.0.0.1/oauth/callback (stavr binds to an ephemeral port at runtime; configure the redirect URI in your App to allow 127.0.0.1).',
            },
            null,
            2,
          ),
        );
        process.exit(1);
      }
      try {
        const result = await runGithubOAuth({
          clientId,
          clientSecret,
          scopes: opts.scopes,
          openBrowser: opts.open !== false,
        });
        const store = new EventStore();
        store.init(opts.db);
        const key = await loadMasterKey();
        const cStore = new CredentialStore(store, key.key);
        const cred = cStore.add({
          user_id: opts.userId,
          service: 'github',
          kind: 'oauth',
          plaintext: result.access_token,
          oauth_refresh_token: result.refresh_token,
          oauth_scopes: result.scope?.split(','),
          metadata: { client_id: clientId, token_type: result.token_type },
        });
        store.close();
        console.log(
          JSON.stringify(
            {
              ok: true,
              credential_id: cred.id,
              service: 'github',
              scopes: cred.oauth_scopes,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        console.error(JSON.stringify({ ok: false, message: (err as Error).message }, null, 2));
        process.exit(1);
      }
    });

  connect
    .command('anthropic')
    .description('Store an Anthropic API key in the vault. Never echoed back.')
    .requiredOption('--key <k>', 'Anthropic API key (sk-ant-...).')
    .option('--user-id <id>', 'User identifier', 'default-user')
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .action(async (opts: { key: string; userId: string; db: string }) => {
      if (!opts.key.startsWith('sk-ant-')) {
        console.error(
          JSON.stringify(
            { ok: false, code: 'INVALID_KEY_SHAPE', message: 'Expected key to start with sk-ant-.' },
            null,
            2,
          ),
        );
        process.exit(1);
      }
      const store = new EventStore();
      store.init(opts.db);
      const key = await loadMasterKey();
      const cStore = new CredentialStore(store, key.key);
      const cred = cStore.add({
        user_id: opts.userId,
        service: 'anthropic',
        kind: 'api_key',
        plaintext: opts.key,
        metadata: { key_prefix: opts.key.slice(0, 12) },
      });
      store.close();
      console.log(
        JSON.stringify(
          {
            ok: true,
            credential_id: cred.id,
            service: 'anthropic',
            key_prefix: cred.metadata.key_prefix,
          },
          null,
          2,
        ),
      );
    });

  const credentials = program
    .command('credentials')
    .description('Manage the credential vault (no secrets are ever printed).');

  credentials
    .command('list')
    .description('List stored credentials with service, kind, expiry, last_used. Never includes the secret.')
    .option('--service <s>', 'Filter to one service.')
    .option('--include-revoked', 'Include revoked credentials.')
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .action(async (opts: { service?: string; includeRevoked?: boolean; db: string }) => {
      const store = new EventStore();
      store.init(opts.db);
      const key = await loadMasterKey();
      const cStore = new CredentialStore(store, key.key);
      const list = cStore.list({ service: opts.service, includeRevoked: opts.includeRevoked });
      console.log(JSON.stringify({ credentials: list }, null, 2));
      store.close();
    });

  credentials
    .command('revoke')
    .description('Revoke a credential immediately. Active grants are revoked in the same transaction.')
    .requiredOption('--id <id>', 'Credential id (e.g. cred-...).')
    .option('--by <who>', 'Identity recording the revocation', 'cli-user')
    .option('--db <path>', 'SQLite path', defaultDbPath())
    .action(async (opts: { id: string; by: string; db: string }) => {
      const store = new EventStore();
      store.init(opts.db);
      const key = await loadMasterKey();
      const cStore = new CredentialStore(store, key.key);
      try {
        const rec = cStore.revoke(opts.id, opts.by);
        console.log(JSON.stringify({ ok: true, credential_id: rec.id, revoked_at: rec.revoked_at }, null, 2));
      } catch (err) {
        console.error(JSON.stringify({ ok: false, message: (err as Error).message }, null, 2));
        process.exit(1);
      } finally {
        store.close();
      }
    });
}

interface GithubOAuthResult {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

async function runGithubOAuth(opts: {
  clientId: string;
  clientSecret: string;
  scopes: string;
  openBrowser: boolean;
}): Promise<GithubOAuthResult> {
  const state = randomBytes(16).toString('hex');
  const code = await captureOAuthCode(state, (port) => {
    const params = new URLSearchParams({
      client_id: opts.clientId,
      scope: opts.scopes,
      state,
      redirect_uri: `http://127.0.0.1:${port}/oauth/callback`,
    });
    const url = `https://github.com/login/oauth/authorize?${params.toString()}`;
    console.error(`Open this URL in your browser to authorize:\n  ${url}`);
    if (opts.openBrowser) openInBrowser(url);
    return url;
  });

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`token exchange failed: HTTP ${tokenRes.status}`);
  }
  const tokenJson = (await tokenRes.json()) as GithubOAuthResult & { error?: string; error_description?: string };
  if (tokenJson.error) {
    throw new Error(`token exchange error: ${tokenJson.error} — ${tokenJson.error_description ?? ''}`);
  }
  if (!tokenJson.access_token) {
    throw new Error('token exchange did not return access_token');
  }
  return tokenJson;
}

/**
 * Bind 127.0.0.1:<ephemeral>, return a Promise<code> when /oauth/callback fires
 * with a matching state. Times out at 5 minutes.
 */
function captureOAuthCode(expectedState: string, onListening: (port: number) => unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) return;
      const url = new URL(req.url, `http://127.0.0.1`);
      if (url.pathname !== '/oauth/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (state !== expectedState) {
        res.statusCode = 400;
        res.end('state mismatch');
        reject(new Error('OAuth state mismatch'));
        server.close();
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end('missing code');
        reject(new Error('OAuth callback missing code'));
        server.close();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><body><h2>Stavr connected. You can close this tab.</h2></body></html>');
      resolve(code);
      server.close();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind OAuth callback server'));
        return;
      }
      onListening(addr.port);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timed out after 5 minutes'));
    }, 5 * 60 * 1000);
    timer.unref();
  });
}

function openInBrowser(url: string): void {
  const cmd =
    platform() === 'win32'
      ? `start "" "${url}"`
      : platform() === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* ignore — User can still copy the URL manually */
  });
}
