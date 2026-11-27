import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { configFile, dataParent, isWindows, readBridgeStatus, readJson } from './wecom-codex/runtime/local.mjs';
import { codexExecutable } from './wecom-codex/runtime/platform.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const pluginName = 'wecom-codex';
const marketplace = 'wecom-local';
const installParent = join(dataParent, 'WeCom Codex Plugins');

async function sameTree(source, target) {
  const [entries, installed] = await Promise.all([readdir(source, { withFileTypes: true }), readdir(target)]);
  if (entries.length !== installed.length || entries.some(entry => !installed.includes(entry.name))) return false;
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      if (!(await stat(to)).isDirectory() || !await sameTree(from, to)) return false;
    } else if (!(await stat(to)).isFile() || !(await readFile(from)).equals(await readFile(to))) return false;
  }
  return true;
}

const psQuote = value => "'" + value.replaceAll("'", "''") + "'";

async function stage(installDir) {
  const staging = await mkdtemp(join(installParent, '.install.'));
  try {
    const catalogDir = join(staging, '.agents', 'plugins');
    const pluginDir = join(staging, pluginName);
    await Promise.all([mkdir(catalogDir, { recursive: true }), mkdir(pluginDir)]);
    await Promise.all([
      cp(join(root, '.agents', 'plugins', 'marketplace.json'), join(catalogDir, 'marketplace.json')),
      cp(join(root, 'LICENSE'), join(staging, 'LICENSE')),
      ...['.codex-plugin', '.mcp.json', 'hooks', 'runtime', 'skills', 'package.json', 'package-lock.json']
        .map(name => cp(join(root, pluginName, name), join(pluginDir, name), { recursive: true })),
    ]);

    if (isWindows) {
      const mcp = join(pluginDir, '.mcp.json');
      const manifest = await readJson(mcp);
      const installedPlugin = join(installDir, pluginName);
      manifest.mcpServers['wecom-settings'] = {
        command: process.execPath,
        args: [join(installedPlugin, 'runtime', 'settings-server.mjs')],
      };
      await writeFile(mcp, JSON.stringify(manifest, null, 2) + '\n');

      const hookPath = join(pluginDir, 'hooks', 'hooks.json');
      const hooks = await readJson(hookPath);
      const entry = join(installedPlugin, 'hooks', 'notify.mjs');
      // A quote-free outer command also works with older Windows Codex hook shells.
      const script = '$OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8; ' +
        `[Console]::In.ReadToEnd() | & ${psQuote(process.execPath)} ${psQuote(entry)}`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      hooks.hooks.Stop[0].hooks[0].commandWindows =
        `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
      await writeFile(hookPath, JSON.stringify(hooks, null, 2) + '\n');
    }

    const existing = await stat(installDir).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) {
      if (!existing.isDirectory() || !await sameTree(staging, installDir)) {
        throw new Error('已有不同的同版本安装文件，请核对原安装目录后再继续。');
      }
    } else {
      await rename(staging, installDir);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function run(executable, args, capture = false) {
  return execFileSync(executable, args, { encoding: 'utf8', windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
}

export async function installPlugin(codex) {
  const { version } = await readJson(join(root, pluginName, '.codex-plugin', 'plugin.json'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('安装包版本无效。');
  const installDir = join(installParent, `${marketplace}-${version}`);
  await mkdir(installParent, { recursive: true });
  await stage(installDir);

  const { marketplaces } = JSON.parse(run(codex, ['plugin', 'marketplace', 'list', '--json'], true));
  const previous = marketplaces.find(item => item.name === marketplace)?.marketplaceSource;
  if (previous && previous.sourceType !== 'local') throw new Error('wecom-local 已被非本地插件源使用。');
  const canonical = value => isWindows ? resolve(value).toLowerCase() : resolve(value);
  if (!previous || canonical(previous.source) !== canonical(installDir)) {
    if (previous) run(codex, ['plugin', 'marketplace', 'remove', marketplace]);
    try {
      run(codex, ['plugin', 'marketplace', 'add', installDir]);
    } catch (error) {
      if (previous) run(codex, ['plugin', 'marketplace', 'add', previous.source]);
      throw error;
    }
  }
  run(codex, ['plugin', 'add', `${pluginName}@${marketplace}`]);
  return installDir;
}

async function install(project) {
  const node = process.versions.node.split('.').map(Number);
  if (node[0] < 22 || (node[0] === 22 && node[1] < 19)) throw new Error('请使用 Node.js 22.19 或更新版本。');
  if (process.platform !== 'darwin' && !isWindows) throw new Error('此安装包支持 macOS 和 Windows。');
  if (!isWindows) process.umask(0o077);
  const codex = codexExecutable();
  try {
    run(codex, ['login', 'status'], true);
  } catch {
    throw new Error('请先在终端运行 codex login 并完成账号登录。');
  }
  const installDir = await installPlugin(codex);

  const manager = join(installDir, pluginName, 'runtime', 'manage.mjs');
  const manage = (...args) => run(process.execPath, [manager, ...args]);
  let status = await readBridgeStatus();
  if (!status && await readJson(configFile, null)) {
    manage('start');
    for (let attempt = 0; attempt < 60 && !status; attempt++) {
      await pause(300);
      status = await readBridgeStatus();
    }
    if (!status) throw new Error('企微后台未就绪，请查看 bridge.log。');
  }
  if (status) {
    manage('update-bridge');
    manage('status');
    if (!status.paired) manage('pair');
  } else {
    const workspace = project ? resolve(project) : join(installParent, 'workspace');
    if (!project) await mkdir(workspace, { recursive: true });
    manage('setup', workspace);
  }
  console.log('请完全退出并重新打开 Codex，然后在插件设置里查找「企微 Codex」。');
}

if (import.meta.main) {
  try {
    await install(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
