import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { isWindows, directory } from './local.mjs';

function findOnPath(name) {
  return (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean).map(folder => resolve(folder.replace(/^"|"$/g, ''), name));
}

export function codexExecutable() {
  if (!isWindows) return execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();

  const triple = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[process.arch];
  const native = findOnPath('codex.exe').find(existsSync);
  if (native) return native;
  const npm = findOnPath('codex.cmd').find(existsSync);
  if (npm && triple) {
    const scope = join(dirname(npm), 'node_modules', '@openai');
    const packageName = 'codex-win32-' + process.arch;
    const candidates = [
      join(scope, packageName, 'vendor', triple, 'bin', 'codex.exe'),
      join(scope, 'codex', 'node_modules', '@openai', packageName, 'vendor', triple, 'bin', 'codex.exe'),
      join(scope, 'codex', 'vendor', triple, 'bin', 'codex.exe'),
    ];
    const binary = candidates.find(existsSync);
    if (binary) return binary;
  }
  throw new Error('找不到 Windows Codex CLI。请先安装并确认 codex --version 可用。');
}

export function installDependencies(cwd) {
  const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  const options = { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true };
  if (!isWindows) {
    execFileSync('npm', args, options);
    return;
  }
  const paths = [dirname(process.execPath), ...findOnPath('npm.cmd').filter(existsSync).map(p => dirname(p))];
  const cli = paths.map(folder => join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(existsSync);
  if (!cli) throw new Error('找不到 npm。请安装带 npm 的 Node.js。');
  execFileSync(process.execPath, [cli, ...args], options);
}

const taskName = 'WeCom Codex ' + createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 16);

export const windowsPowerShell = join(process.env.SystemRoot || 'C:/Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function runWindowsTask(action, entry) {
  const script = {
    state: `$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) { [string]$task.State }`,
    start: 'Start-ScheduledTask -TaskName $taskName',
    stop: 'Stop-ScheduledTask -TaskName $taskName',
    register: `$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $env:WE_COM_TASK_NODE -Argument ('"' + $env:WE_COM_TASK_ENTRY + '"') -WorkingDirectory $env:WE_COM_TASK_CWD
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
  }[action];
  const command = Buffer.from("$ErrorActionPreference = 'Stop'; $taskName = $env:WE_COM_TASK_NAME; " +
    script, 'utf16le').toString('base64');
  try {
    return execFileSync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20_000,
      env: { ...process.env, WE_COM_TASK_NAME: taskName, WE_COM_TASK_ENTRY: entry ?? '',
        WE_COM_TASK_NODE: process.execPath, WE_COM_TASK_CWD: directory },
    }).trim();
  } catch (error) {
    throw new Error('Windows 任务计划程序操作失败。请在当前用户的 PowerShell 中检查任务计划程序。', { cause: error });
  }
}
