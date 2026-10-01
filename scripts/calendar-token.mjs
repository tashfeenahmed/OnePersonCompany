// Mint a Google refresh token for the calendar plugin, with the scope that can
// create, change and delete events (https://www.googleapis.com/auth/calendar).
//
//   npm run calendar-token -- <client-id> <client-secret>
//   (or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the environment)
//
// Uses Google's loopback flow, so the OAuth client must be a "Desktop app"
// client — the same one the Gmail plugin uses is fine. A browser opens on the
// consent screen; sign in as the calendar's account, allow, and the refresh
// token is printed here. Paste it, with the same client id and secret, into
// Integrations → Calendar. Nothing is stored by this script.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const clientId = process.argv[2] ?? process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.argv[3] ?? process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Usage: npm run calendar-token -- <client-id> <client-secret>');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirect = `http://127.0.0.1:${server.address().port}`;

const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
for (const [k, v] of Object.entries({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
})) auth.searchParams.set(k, v);

const code = await new Promise((resolve, reject) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirect);
    if (url.pathname !== '/') return res.writeHead(404).end();
    const got = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const ok = !!got && url.searchParams.get('state') === state;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(ok ? 'Done — you can close this tab and go back to the terminal.' : `Not done: ${error ?? 'state mismatch'}`);
    if (ok) resolve(got);
    else reject(new Error(error ?? 'state mismatch'));
  });
  console.log(`Opening Google's consent screen. If no browser opens, visit:\n\n${auth}\n`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [auth.toString()], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}).finally(() => server.close());

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  }),
});
const doc = await res.json();
if (!res.ok || !doc.refresh_token) {
  console.error('Google refused the exchange:', doc.error_description ?? doc.error ?? res.status);
  process.exit(1);
}
console.log(`Scopes: ${doc.scope}\n\nRefresh token:\n${doc.refresh_token}`);
