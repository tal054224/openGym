/* Shared boot for the food and service-auth tests: a real server.js on PORT=0 with its own data
   directory, two profiles, and (optionally) a service secret file. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICE_SECRET = 's'.repeat(48);

export async function startFoodServer(t, { service = true, env = {}, users } = {}) {
  const secret = crypto.randomBytes(32).toString('hex');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-food-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
  const people = users || [
    { id: 'u_food_a', name: 'A', created: new Date().toISOString() },
    { id: 'u_food_b', name: 'B', created: new Date().toISOString() },
    { id: 'u_food_off', name: 'Off', created: new Date().toISOString(), disabled: true }
  ];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: people, creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, 'state-u_food_a.json'), JSON.stringify({ unit: 'kg', routines: [], workouts: [], bodyweight: [], _rev: 3 }));
  const tokenFile = path.join(dataDir, 'service-token');
  if (service) fs.writeFileSync(tokenFile, SERVICE_SECRET + '\n', { mode: 0o600 });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost',
      MEDIA_UPLOADS: '0', COACH_DISABLED: '1', ...(service ? { MCP_SERVICE_TOKEN_FILE: tokenFile } : {}), ...env
    }
  });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const port = await boundPort(child, () => log);
  const base = `http://127.0.0.1:${port}`;
  const mint = uid => {
    const payload = `${uid}:${Date.now() + 86400000}:0`;
    return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  };
  const call = async (method, p, { body, headers = {} } = {}) => {
    const r = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const as = uid => (method, p, opts = {}) => call(method, p, { ...opts, headers: { Cookie: `gymsid=${mint(uid)}`, ...(opts.headers || {}) } });
  const svc = (uid, secretValue = SERVICE_SECRET) => (method, p, opts = {}) => call(method, p, {
    ...opts, headers: { 'X-OpenGym-Service-Token': secretValue, ...(uid ? { 'X-OpenGym-Profile': uid } : {}), ...(opts.headers || {}) }
  });
  return { base, dataDir, call, as, svc, mint, log: () => log };
}

export const entry = (over = {}) => ({ date: '2026-10-09', meal: 'breakfast', name: 'Oatmeal', quantity: 80, unit: 'g', calories: 300, protein_g: 10, carbs_g: 54, fat_g: 6, ...over });
