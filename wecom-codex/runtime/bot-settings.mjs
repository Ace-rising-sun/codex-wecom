import { execFileSync, spawn } from 'node:child_process';
import { realpath, rm, stat } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { configFile, control, readJson, saveJson } from './local.mjs';

const manager = fileURLToPath(new URL('manage.mjs', import.meta.url));
const run = action => execFileSync(process.execPath, [manager, action], { stdio: 'pipe' });

export async function readBotSettings() {
  const { botId = '', workspace = '', secret } = await readJson(configFile, {});
  return { botId, workspace, configured: Boolean(secret) };
}

async function waitFor(matches) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await control('/status').catch(() => undefined);
    if (matches(status)) return status;
    await pause(300);
  }
  throw new Error('企微长连接未能在规定时间内完成认证。');
}

function initialSetup(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [manager, 'configure-stdin'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('后台服务初始化失败。')));
    child.stdin.end(JSON.stringify(input));
  });
}

export async function configureBot({ botId, secret, workspace }) {
  const previous = await readJson(configFile, null);
  if (typeof botId !== 'string' || !/^[\w-]{6,160}$/.test(botId)) throw new Error('请核对企微 Bot ID。');
  const nextSecret = secret || (previous?.botId === botId ? previous.secret : '');
  if (typeof nextSecret !== 'string' || !/^[\w-]{12,200}$/.test(nextSecret)) throw new Error('请填写企微 Bot Secret。');
  const cwd = await realpath(workspace).catch(() => undefined);
  if (!cwd || !(await stat(cwd)).isDirectory()) throw new Error('请选择存在的本机工作目录。');

  const initial = await control('/status').catch(() => undefined);
  if (initial?.active || initial?.waiting > 0) throw new Error('企微还有任务在运行，结束后再保存连接配置。');
  let status;
  if (!previous) {
    try {
      await initialSetup({ botId, secret: nextSecret, workspace: cwd });
      status = await waitFor(candidate => candidate?.connected);
    } catch (error) {
      run('stop');
      await rm(configFile, { force: true });
      throw error;
    }
  } else {
    run('stop');
    try {
      await waitFor(status => status === undefined);
      await saveJson(configFile, { ...previous, botId, secret: nextSecret, workspace: cwd });
      run('start');
      status = await waitFor(candidate => candidate?.connected);
    } catch {
      try {
        run('stop');
        await waitFor(status => status === undefined);
        await saveJson(configFile, previous);
        if (initial) {
          run('start');
          if (initial.connected) await waitFor(status => status?.connected);
        }
      } catch {
        throw new Error('新配置未通过验证，旧连接也未能恢复。');
      }
      throw new Error('新配置未通过验证，已恢复旧配置。');
    }
  }

  const pair = status.paired ? undefined : (await control('/pair', {})).command;
  return { connected: true, paired: status.paired, pair };
}
