import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState, type NodeSavedStateStore, type NodeSavedSessionStore } from "@atproto/oauth-client-node";
import { Agent, CredentialSession } from "@atproto/api";
import { Hono } from "hono";
import { serve as honoNodeServe } from "@hono/node-server";
import open from "open";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { isBun } from "./runtime";

// OAuth scope for CLI
const OAUTH_SCOPE = 'atproto repo:place.wisp.fs repo:place.wisp.subfs repo:place.wisp.settings blob:*/*';

// Default session store path
const DEFAULT_STORE_PATH = join(homedir(), '.wisp', 'oauth-session.json');

// Loopback server config
const LOOPBACK_PORT = 4000;
const LOOPBACK_HOST = '127.0.0.1';

interface StoredData {
  states: Record<string, NodeSavedState>;
  sessions: Record<string, NodeSavedSession>;
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadStore(storePath: string): StoredData {
  if (!existsSync(storePath)) {
    return { states: {}, sessions: {} };
  }
  try {
    const content = readFileSync(storePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { states: {}, sessions: {} };
  }
}

function saveStore(storePath: string, data: StoredData) {
  ensureDir(storePath);
  writeFileSync(storePath, JSON.stringify(data, null, 2));
}

function createStateStore(storePath: string): NodeSavedStateStore {
  return {
    async set(key: string, state: NodeSavedState) {
      const data = loadStore(storePath);
      data.states[key] = state;
      saveStore(storePath, data);
    },
    async get(key: string) {
      const data = loadStore(storePath);
      return data.states[key];
    },
    async del(key: string) {
      const data = loadStore(storePath);
      delete data.states[key];
      saveStore(storePath, data);
    }
  };
}

function createSessionStore(storePath: string): NodeSavedSessionStore {
  return {
    async set(sub: string, session: NodeSavedSession) {
      const data = loadStore(storePath);
      data.sessions[sub] = session;
      saveStore(storePath, data);
    },
    async get(sub: string) {
      const data = loadStore(storePath);
      return data.sessions[sub];
    },
    async del(sub: string) {
      const data = loadStore(storePath);
      delete data.sessions[sub];
      saveStore(storePath, data);
    }
  };
}

export interface AuthOptions {
  storePath?: string;
  appPassword?: string;
}

/**
 * Authenticate with AT Protocol using OAuth loopback flow
 */
export async function authenticateOAuth(
  handle: string,
  options: AuthOptions = {}
): Promise<{ agent: Agent; did: string }> {
  const storePath = options.storePath || DEFAULT_STORE_PATH;

  // Build loopback client metadata
  const redirectUri = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}/oauth/callback`;
  const clientIdParams = new URLSearchParams();
  clientIdParams.append('redirect_uri', redirectUri);
  clientIdParams.append('scope', OAUTH_SCOPE);

  const client = new NodeOAuthClient({
    clientMetadata: {
      client_id: `http://localhost?${clientIdParams.toString()}`,
      client_name: "Wisp CLI",
      client_uri: "https://wisp.place",
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPE,
      dpop_bound_access_tokens: false,
    },
    stateStore: createStateStore(storePath),
    sessionStore: createSessionStore(storePath),
  });

  // Try to restore existing session
  const data = loadStore(storePath);
  const existingSessions = Object.keys(data.sessions);

  // Check if we have a session for this handle's DID
  for (const sub of existingSessions) {
    try {
      const session = await client.restore(sub);
      if (session) {
        // Verify session is still valid
        const agent = new Agent(session);
        const profile = await agent.getProfile({ actor: sub });

        // Check if this is the handle we want
        if (profile.data.handle === handle || sub === handle) {
          console.log(`Restored existing session for ${profile.data.handle}`);
          return { agent, did: sub };
        }
      }
    } catch {
      // Session invalid, continue
    }
  }

  // Start new OAuth flow
  console.log(`Starting OAuth flow for ${handle}...`);

  // Create loopback server to receive callback
  const callbackPromise = new Promise<{ params: URLSearchParams }>((resolve, reject) => {
    const app = new Hono();
    let serverHandle: { close: () => void } | null = null;

    const successHtml = `
      <html>
        <head><title>Wisp CLI - Authentication Successful</title></head>
        <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
          <div style="text-align: center;">
            <h1>Authentication Successful</h1>
            <p>You can close this window and return to the CLI.</p>
          </div>
        </body>
      </html>
    `;

    app.get('/oauth/callback', (c) => {
      const params = new URLSearchParams(c.req.url.split('?')[1] || '');

      // Close server after receiving callback
      setTimeout(() => serverHandle?.close(), 100);

      resolve({ params });

      return c.html(successHtml);
    });

    app.all('*', (c) => c.text('Not found', 404));

    // Start server based on runtime
    if (isBun) {
      // @ts-ignore - Bun global
      const bunServer = Bun.serve({
        port: LOOPBACK_PORT,
        hostname: LOOPBACK_HOST,
        fetch: app.fetch,
      });
      serverHandle = { close: () => bunServer.stop() };
    } else {
      const nodeServer = honoNodeServe({
        fetch: app.fetch,
        port: LOOPBACK_PORT,
        hostname: LOOPBACK_HOST,
      });
      serverHandle = { close: () => nodeServer.close() };
    }

    // Timeout after 5 minutes
    setTimeout(() => {
      serverHandle?.close();
      reject(new Error('OAuth callback timeout'));
    }, 5 * 60 * 1000);
  });

  // Get authorization URL
  const authUrl = await client.authorize(handle, {
    scope: OAUTH_SCOPE,
  });

  // Open browser
  console.log(`Opening browser for authentication...`);
  console.log(`If browser doesn't open, visit: ${authUrl}`);
  await open(authUrl.toString());

  // Wait for callback
  const { params } = await callbackPromise;

  // Handle callback
  const { session } = await client.callback(params);

  const agent = new Agent(session);
  const did = session.did;

  console.log(`Successfully authenticated as ${did}`);

  return { agent, did };
}

/**
 * Authenticate with AT Protocol using app password (for CI/headless)
 */
export async function authenticateAppPassword(
  identifier: string,
  password: string,
  pdsUrl?: string
): Promise<{ agent: Agent; did: string }> {
  const serviceUrl = pdsUrl || 'https://bsky.social';

  const credSession = new CredentialSession(new URL(serviceUrl));
  await credSession.login({ identifier, password });

  const agent = new Agent(credSession);
  const did = credSession.did!;

  console.log(`Successfully authenticated as ${did}`);

  return { agent, did };
}

/**
 * Authenticate - tries OAuth if no password provided, otherwise uses app password
 */
export async function authenticate(
  handle: string,
  options: AuthOptions = {}
): Promise<{ agent: Agent; did: string }> {
  if (options.appPassword) {
    return authenticateAppPassword(handle, options.appPassword);
  }
  return authenticateOAuth(handle, options);
}

/**
 * Clear stored OAuth sessions
 */
export function clearSessions(storePath?: string) {
  const path = storePath || DEFAULT_STORE_PATH;
  if (existsSync(path)) {
    unlinkSync(path);
    console.log('Cleared stored OAuth sessions');
  }
}
