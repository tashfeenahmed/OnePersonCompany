import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = process.env.OPC_ENV_FILE ?? root + 'server/.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);
const api = Number(process.env.PORT || 8787), ui = Number(process.env.OPC_UI_PORT || 5180);
if (api === ui) throw new Error('PORT and OPC_UI_PORT must use different ports.');
async function available(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  await new Promise((resolve, reject) => { const server = createServer(); server.once('error', () => reject(new Error(`Port ${port} is busy. Stop the other process or choose another PORT / OPC_UI_PORT.`))); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
}
await available(api); await available(ui);
const children = [
  spawn(process.execPath, ['--watch', '--experimental-strip-types', 'src/index.ts'], { cwd: root + 'server', stdio: 'inherit', env: process.env }),
  spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(ui), '--strictPort'], { cwd: root + 'client', stdio: 'inherit', env: { ...process.env, VITE_PROXY_TARGET: `http://127.0.0.1:${api}` } }),
];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); process.exitCode = code; }
for (const child of children) { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => stop(code || 0)); }
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
console.log(`Workspace: http://127.0.0.1:${ui} · API: http://127.0.0.1:${api}`);
