import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const windows = process.platform === 'win32';
const installer = new URL('../install.mjs', import.meta.url).href;
const platform = new URL('../wecom-codex/runtime/platform.mjs', import.meta.url).href;
const windowsOnly = !windows || !process.env.WE_COM_TEST_CODEX;

async function environment(t) {
  const home = await mkdtemp(join(tmpdir(), 'wecom install-'));
  await mkdir(join(home, '.codex'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 4 }));
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
    CODEX_HOME: join(home, '.codex') } };
}

function nodeScript(env, program) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    env, encoding: 'utf8', timeout: 70_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('real Codex registers the plugin and loads the installed settings server', {
  skip: !process.env.WE_COM_TEST_CODEX, timeout: 90_000,
}, async t => {
  const { env } = await environment(t);
  const stdout = nodeScript(env, `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { installPlugin } from ${JSON.stringify(installer)};
    import { codexExecutable } from ${JSON.stringify(platform)};

    const codex = codexExecutable();
    const codexJson = args => JSON.parse(execFileSync(codex, args, { encoding: 'utf8', windowsHide: true }));
    const root = await installPlugin(codex);
    assert.equal(await installPlugin(codex), root);

    const listed = codexJson(['plugin','list','--marketplace','wecom-local','--json']);
    const installed = listed.installed.find(row => row.pluginId === 'wecom-codex@wecom-local');
    assert.equal(installed.version, '0.4.0');
    assert.equal(installed.enabled, true);

    const cached = join(process.env.CODEX_HOME, 'plugins', 'cache', 'wecom-local', 'wecom-codex', installed.version);
    const mcp = JSON.parse(await readFile(join(cached,'.mcp.json'), 'utf8')).mcpServers['wecom-settings'];
    if (process.platform === 'win32') {
      assert.equal(mcp.command, process.execPath);
      assert.equal(mcp.args[0], join(root, 'wecom-codex','runtime','settings-server.mjs'));
    }
    const args = mcp.args.map(arg => arg.replace('\${PLUGIN_ROOT}',cached));
    const input = JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{}}) + '\\n';
    const settings = JSON.parse(execFileSync(mcp.command, args, {input, encoding:'utf8',windowsHide:true,timeout:10000}));
    assert.equal(settings.result.resultType, 'complete');

    if (process.platform === 'win32') {
      const hooks = JSON.parse(await readFile(join(cached,'hooks','hooks.json'), 'utf8'));
      const command = hooks.hooks.Stop[0].hooks[0].commandWindows;
      const output = execFileSync('cmd.exe', ['/d', '/s', '/c', command], {
        input:'{}', encoding:'utf8', windowsHide:true, timeout:10000,
      });
      assert.deepEqual(JSON.parse(output), {});
    }
    console.log('installed settings verified');
  `);
  assert.match(stdout, /installed settings verified/);
});

test('Windows starts and stops the per-user scheduled task', { skip: windowsOnly, timeout: 85_000 }, async t => {
  const { home, env } = await environment(t);
  const data = join(home, 'WeCom Codex');
  const entry = join(home, 'scheduled.mjs');
  const marker = join(home, 'started');
  const taskName = 'WeCom Codex ' + createHash('sha256').update(data.toLowerCase()).digest('hex').slice(0, 16);
  await mkdir(data);
  await writeFile(entry, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, process.cwd());
    setInterval(() => {}, 1000);
  `);
  try {
    nodeScript(env, `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync } from 'node:fs';
      import { setTimeout as pause } from 'node:timers/promises';
      import { runWindowsTask } from ${JSON.stringify(platform)};
      runWindowsTask('register', ${JSON.stringify(entry)});
      runWindowsTask('start');
      for (let i = 0; i < 100 && !existsSync(${JSON.stringify(marker)}); i++) await pause(200);
      assert.equal(readFileSync(${JSON.stringify(marker)}, 'utf8').toLowerCase(), ${JSON.stringify(data.toLowerCase())});
      assert.equal(runWindowsTask('state'), 'Running');
      runWindowsTask('stop');
    `);
  } finally {
    const script = "Unregister-ScheduledTask -TaskName '" + taskName + "' -Confirm:$false -ErrorAction SilentlyContinue";
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: 'ignore', timeout: 12_000,
    });
  }
});
