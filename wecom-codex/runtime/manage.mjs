import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { configFile, control, directory, label, plist, prepareDirectory, readJson, saveJson, stateFile } from './local.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = join(directory, 'package');
const domain = `gui/${process.getuid?.()}`;

function launchctl(...args) {
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function loaded() {
  try {
    launchctl('print', `${domain}/${label}`);
    return true;
  } catch {
    return false;
  }
}

function start() {
  if (!loaded()) launchctl('bootstrap', domain, plist);
}

async function waitForBridge(accept, failure) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await control('/status').catch(error => {
      if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) return undefined;
      throw error;
    });
    if (accept(status)) return;
    await pause(300);
  }
  throw new Error(failure);
}

async function updateBridge() {
  const files = (await Promise.all(['model-settings.mjs', 'codex.mjs', 'bridge.mjs'].map(async name => {
    const target = join(runtime, 'runtime', name);
    const [previous, next] = await Promise.all([readFile(target), readFile(join(root, 'runtime', name))]);
    return { target, temporary: `${target}.${randomUUID()}`, previous, next };
  }))).filter(file => !file.previous.equals(file.next));
  if (!files.length) return;
  const initial = await control('/status');
  if (initial.active || initial.waiting > 0) throw new Error('企微还有任务，请在任务结束后更新后台服务。');
  async function replace(version) {
    for (const file of files) {
      await writeFile(file.temporary, file[version], { mode: 0o600, flag: 'wx' });
      await rename(file.temporary, file.target);
    }
  }
  const cleanStaging = () => Promise.all(files.map(file => rm(file.temporary, { force: true })));
  async function stopBridge() {
    try {
      launchctl('bootout', `${domain}/${label}`);
    } catch (error) {
      if (!/Boot-out failed: 3:/.test(error.stderr ?? '')) throw error;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!loaded()) return;
      await pause(300);
    }
    throw new Error('企微后台服务未能停止。');
  }
  const waitForReady = () => waitForBridge(status => status?.connected && status.paired === initial.paired,
    '企微后台服务未能恢复连接或配对状态。');

  try {
    await stopBridge();
    await replace('next');
    launchctl('bootstrap', domain, plist);
    await waitForReady();
    console.log('企微后台服务已更新。');
  } catch (error) {
    try {
      await stopBridge();
      await cleanStaging();
      await replace('previous');
      launchctl('bootstrap', domain, plist);
      await waitForReady();
    } catch (restoreError) {
      throw new Error(`更新失败：${error.message} 旧后台服务未能恢复：${restoreError.message}`, { cause: error });
    }
    throw new Error(`更新失败，旧后台服务已恢复。${error.message}`, { cause: error });
  } finally {
    await cleanStaging();
  }
}

async function ask(defaultWorkspace) {
  if (!process.stdin.isTTY) throw new Error('请在 Mac 终端运行 setup');
  let hidden = false;
  const display = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stderr.write(chunk);
      done();
    },
  });
  const input = createInterface({ input: process.stdin, output: display, terminal: true });
  try {
    const botId = (await input.question('企微 Bot ID：')).trim();
    process.stderr.write('企微 Secret（隐藏输入）：');
    hidden = true;
    const secret = (await input.question('')).trim();
    hidden = false;
    process.stderr.write('\n');
    const workspace = (await input.question(`工作目录 [${defaultWorkspace}]：`)).trim() || defaultWorkspace;
    return { botId, secret, workspace };
  } finally {
    input.close();
  }
}

function executable(name) {
  return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function setup(input) {
  if (process.platform !== 'darwin') throw new Error('此插件的后台服务需要 macOS');
  if (loaded()) throw new Error('服务正在运行。重新配置前先执行 stop。');
  if (!/^[\w-]{6,160}$/.test(input.botId ?? '') || !/^[\w-]{12,200}$/.test(input.secret ?? '')) {
    throw new Error('请在企微机器人配置页核对 Bot ID 和 Secret');
  }
  const workspace = await realpath(input.workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error('工作目录不存在');
  const codex = executable('codex');
  const npm = executable('npm');

  await prepareDirectory();
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await Promise.all(['runtime', 'package.json', 'package-lock.json'].map(name =>
    cp(join(root, name), join(runtime, name), { recursive: true })));
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: runtime, stdio: ['ignore', 'ignore', 'pipe'],
  });

  const previous = await readJson(stateFile, {});
  const paired = previous.botId === input.botId && previous.workspace === workspace && Boolean(previous.owner);
  await saveJson(configFile, { botId: input.botId, secret: input.secret, workspace, codex });
  await mkdir(dirname(plist), { recursive: true });
  const argumentsXml = [process.execPath, join(runtime, 'runtime', 'bridge.mjs')]
    .map(value => `<string>${xml(value)}</string>`).join('');
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>${xml(join(directory, 'bridge.log'))}</string>
</dict></plist>\n`, { mode: 0o600 });
  await chmod(plist, 0o600);
  start();
  console.log('已启动企微连接服务。');
  if (!paired) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const { command } = await control('/pair', {});
        console.log(command);
        return;
      } catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    throw new Error('后台服务尚未就绪，请使用 status 检查');
  }
}

const [action, ...args] = process.argv.slice(2);
try {
  switch (action) {
    case 'setup': await setup(await ask(args[0] ?? process.cwd())); break;
    case 'configure-stdin': await setup(JSON.parse(await text(process.stdin))); break;
    case 'start': start(); break;
    case 'stop': if (loaded()) launchctl('bootout', `${domain}/${label}`); break;
    case 'update-bridge': await updateBridge(); break;
    case 'status': console.log(JSON.stringify(await control('/status'))); break;
    case 'pair': console.log((await control('/pair', {})).command); break;
    case 'notice':
      if (!args[0]?.trim()) throw new Error('请输入要发给已配对账号的消息');
      await control('/notice', { message: args.join(' ') });
      console.log('企微接口确认已发送。');
      break;
    default: throw new Error('可用命令：setup、status、start、stop、update-bridge、pair、notice');
  }
} catch (error) {
  console.error(error.code === 'ENOENT' && action === 'status' ? '企微连接服务尚未启动。' : error.message);
  process.exitCode = 1;
}
