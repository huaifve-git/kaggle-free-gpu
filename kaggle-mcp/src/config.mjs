/**
 * Credential + path resolution for the Kaggle RVC MCP server.
 *
 * Resolution order (first hit wins):
 *   1. env KAGGLE_API_TOKEN            -> bearer token (KGAT_...)
 *   2. env KAGGLE_USERNAME + KAGGLE_KEY -> HTTP basic
 *   3. <home>/.kaggle/access_token     -> bearer token file
 *   4. <home>/.kaggle/kaggle.json      -> { username, key }
 *   5. <workspace>/.secrets/kaggle.env -> KEY=VALUE lines
 *   6. <workspace>/.secrets/kaggle.json
 *
 * Nothing here ever logs or returns the secret in tool output.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KAGGLE_API_BASE = 'https://www.kaggle.com/api/v1';

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{ workspace?: string }} [opts]
 * @returns {{ header: Record<string,string>, username: string|null, source: string, kind: 'bearer'|'basic' } | null}
 */
export function loadCredentials(opts = {}) {
  const workspace = opts.workspace ?? process.env.KAGGLE_RVC_HOME ?? process.cwd();
  const home = os.homedir();

  const tokenFromEnv = process.env.KAGGLE_API_TOKEN?.trim();
  if (tokenFromEnv) {
    return authFromToken(tokenFromEnv, process.env.KAGGLE_USERNAME?.trim() ?? null, 'env:KAGGLE_API_TOKEN');
  }

  const envUser = process.env.KAGGLE_USERNAME?.trim();
  const envKey = process.env.KAGGLE_KEY?.trim();
  if (envUser && envKey) {
    return authFromBasic(envUser, envKey, 'env:KAGGLE_USERNAME+KAGGLE_KEY');
  }

  const tokenFile = path.join(home, '.kaggle', 'access_token');
  if (fs.existsSync(tokenFile)) {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (t) return authFromToken(t, envUser ?? null, tokenFile);
  }

  const kaggleJson = path.join(home, '.kaggle', 'kaggle.json');
  const kj = readJson(kaggleJson);
  if (kj?.username && kj?.key) {
    return authFromBasic(kj.username, kj.key, kaggleJson);
  }

  const localEnv = readEnvFile(path.join(workspace, '.secrets', 'kaggle.env'));
  if (localEnv.KAGGLE_API_TOKEN) {
    return authFromToken(
      localEnv.KAGGLE_API_TOKEN,
      localEnv.KAGGLE_USERNAME ?? envUser ?? null,
      path.join(workspace, '.secrets', 'kaggle.env'),
    );
  }
  if (localEnv.KAGGLE_USERNAME && localEnv.KAGGLE_KEY) {
    return authFromBasic(
      localEnv.KAGGLE_USERNAME,
      localEnv.KAGGLE_KEY,
      path.join(workspace, '.secrets', 'kaggle.env'),
    );
  }

  const localJson = readJson(path.join(workspace, '.secrets', 'kaggle.json'));
  if (localJson?.username && localJson?.key) {
    return authFromBasic(localJson.username, localJson.key, path.join(workspace, '.secrets', 'kaggle.json'));
  }

  return null;
}

function authFromToken(token, username, source) {
  return {
    header: { Authorization: `Bearer ${token}` },
    username: username ?? null,
    source,
    kind: /** @type {const} */ ('bearer'),
  };
}

function authFromBasic(username, key, source) {
  const encoded = Buffer.from(`${username}:${key}`).toString('base64');
  return {
    header: { Authorization: `Basic ${encoded}` },
    username,
    source,
    kind: /** @type {const} */ ('basic'),
  };
}

/** Resolve the working root for local kernel scaffolding. */
export function resolveWorkspace(opts = {}) {
  const ws = opts.workspace ?? process.env.KAGGLE_RVC_HOME ?? process.cwd();
  return path.resolve(ws);
}

/** Directory holding locally scaffolded kernels: <workspace>/kernels */
export function kernelsRoot(opts = {}) {
  const dir = process.env.KAGGLE_RVC_KERNELS_DIR
    ? path.resolve(process.env.KAGGLE_RVC_KERNELS_DIR)
    : path.join(resolveWorkspace(opts), 'kernels');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Directory holding downloaded kernel outputs: <workspace>/outputs */
export function outputsRoot(opts = {}) {
  const dir = process.env.KAGGLE_RVC_OUTPUTS_DIR
    ? path.resolve(process.env.KAGGLE_RVC_OUTPUTS_DIR)
    : path.join(resolveWorkspace(opts), 'outputs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The Kaggle username: explicit config first, then env, then whatever the profile provides. */
export function resolveUsername(explicit) {
  return (
    explicit?.trim() ||
    process.env.KAGGLE_RVC_USERNAME?.trim() ||
    process.env.KAGGLE_USERNAME?.trim() ||
    null
  );
}
