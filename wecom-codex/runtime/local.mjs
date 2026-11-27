import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';

export const isWindows = process.platform === 'win32';
export const dataParent = isWindows
  ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  : join(homedir(), 'Library', 'Application Support');
export const directory = join(dataParent, 'WeCom Codex');
export const configFile = join(directory, 'config.json');
export const stateFile = join(directory, 'state.json');
export const socket = isWindows
  ? '\\\\.\\pipe\\wecom-codex-' + createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 32)
  : join(directory, 'control.sock');
export const label = 'local.wecom-codex';
export const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function prepareDirectory() {
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (!isWindows) await chmod(directory, 0o700);
}

export async function saveJson(path, data) {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function control(path, data, timeout = 20_000) {
  const headers = {};
  if (isWindows) {
    const { controlKey } = await readJson(configFile);
    headers.Authorization = `Bearer ${controlKey}`;
  }
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = request({ socketPath: socket, path, method: body ? 'POST' : 'GET', headers }, res => {
      let reply = '';
      res.setEncoding('utf8').on('data', part => { reply += part; });
      res.once('end', () => {
        try {
          const payload = JSON.parse(reply);
          if (res.statusCode === 200) resolve(payload);
          else reject(new Error(payload.error ?? '本地服务请求失败'));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('本地服务请求超时')));
    req.once('error', reject);
    req.end(body);
  });
}

export async function readBridgeStatus() {
  try {
    return await control('/status');
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) return undefined;
    throw error;
  }
}
