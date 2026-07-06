// connect.js
// Run this ONCE on your own computer to authorize WHOOP and save a refresh token
// into your Supabase `whoop_tokens` table. After this, the nightly pull runs on its
// own using that refresh token — you never have to log in again.
//
//   1. npm install
//   2. copy .env.example to .env and fill it in
//   3. npm run connect
//   4. a browser opens -> log into WHOOP -> approve -> done
//
// If your browser doesn't open automatically, copy the URL this script prints
// into your browser manually.

import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  SUPABASE_URL,
  SUPABASE_SECRET,
  WHOOP_REDIRECT_URI = 'http://localhost:3000/callback',
} = process.env;

for (const [k, v] of Object.entries({
  WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SECRET,
})) {
  if (!v) { console.error(`Missing env var: ${k}. Fill in your .env file.`); process.exit(1); }
}

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

// The data we want to read, plus "offline" so we get a refresh token.
const SCOPES = [
  'offline',
  'read:recovery',
  'read:sleep',
  'read:cycles',
  'read:workout',
  'read:profile',
  'read:body_measurement',
].join(' ');

const state = crypto.randomBytes(8).toString('hex'); // random anti-CSRF value
const redirect = new URL(WHOOP_REDIRECT_URI);
const port = Number(redirect.port || 3000);
const callbackPath = redirect.pathname || '/callback';

const authorizeUrl = `${AUTH_URL}?${new URLSearchParams({
  response_type: 'code',
  client_id: WHOOP_CLIENT_ID,
  redirect_uri: WHOOP_REDIRECT_URI,
  scope: SCOPES,
  state,
})}`;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET, {
  auth: { persistSession: false },
});

async function exchangeCodeForTokens(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: WHOOP_REDIRECT_URI,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function saveTokens({ access_token, refresh_token, expires_in }) {
  const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
  const { error } = await supabase.from('whoop_tokens').upsert({
    id: 1,
    access_token,
    refresh_token,
    expires_at,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Saving tokens to Supabase failed: ${error.message}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname !== callbackPath) { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const err = url.searchParams.get('error');

  try {
    if (err) throw new Error(`WHOOP returned an error: ${err}`);
    if (returnedState !== state) throw new Error('State mismatch — possible CSRF, aborting.');
    if (!code) throw new Error('No authorization code received.');

    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      throw new Error('No refresh token returned. Make sure the "offline" scope is included.');
    }
    await saveTokens(tokens);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>WHOOP connected ✅</h2><p>Refresh token saved. You can close this tab and return to your terminal.</p>');
    console.log('\n✅ Success — refresh token saved to Supabase (whoop_tokens, id=1).');
    console.log('You can now run "npm run pull" locally to test, or let the GitHub Action do it nightly.\n');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>Something went wrong</h2><pre>${e.message}</pre>`);
    console.error('\n❌ ' + e.message + '\n');
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 200);
  }
});

server.listen(port, () => {
  console.log(`\nListening on ${WHOOP_REDIRECT_URI}`);
  console.log('\nOpen this URL in your browser to authorize WHOOP:\n');
  console.log(authorizeUrl + '\n');
  // Best-effort auto-open (works on most machines; ignore if it fails).
  import('node:child_process').then(({ exec }) => {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start ""'
      : 'xdg-open';
    exec(`${cmd} "${authorizeUrl}"`, () => {});
  }).catch(() => {});
});
