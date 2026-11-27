import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { memberAccessModes } from '../wecom-codex/runtime/model-settings.mjs';

const sdk = `
  import { EventEmitter } from 'node:events';
  import { createInterface } from 'node:readline';
  import { randomUUID } from 'node:crypto';
  const record = event => console.log(JSON.stringify(event));
  export const generateReqId = () => randomUUID();
  export class WSClient extends EventEmitter {
    connect() {
      createInterface({ input: process.stdin }).on('line', line => this.emit('message', JSON.parse(line)));
      this.emit('authenticated');
      record({ type: 'ready' });
    }
    disconnect() {}
    async replyStream(frame, _id, text) {
      record({ type: 'reply', id: frame.body.msgid, text });
    }
    async sendMessage(to, body) {
      record({ type: 'message', to, text: body.markdown.content });
    }
  }
`;

const appServer = `#!/usr/bin/env node
  const { createInterface } = require('node:readline');
  const { randomUUID } = require('node:crypto');
  const { existsSync, writeFileSync } = require('node:fs');
  const send = value => console.log(JSON.stringify(value));
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    if (method === 'thread/start') return send({ id, result: { thread: { id: randomUUID() } } });
    if (method === 'thread/read') return send({ id, result: { thread: { name: '插件设置优化' } } });
    if (method === 'thread/items/list') return send({ id, result: { data: [
      { turnId: 'another-turn', item: { type: 'userMessage', content: [{ type: 'text', text: '另一轮任务' }] } },
      { turnId: params.turnId, item: { type: 'userMessage', content: [{ type: 'text',
        text: '改成通知弹窗 Secret=test-only-value\\n敏感附件详情' }] } },
    ] } });
    if (method !== 'turn/start') return send({ id, result: {} });
    writeFileSync('last-turn-context.json', JSON.stringify(params.additionalContext));
    const { threadId, input } = params;
    const turnId = randomUUID();
    send({ id, result: { turn: { id: turnId } } });
    const finish = () => {
      send({ method: 'item/completed', params: {
        threadId, turnId, item: { type: 'agentMessage', text: threadId + ' ' + input[0].text }
      } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    };
    if (input[0].text !== '占住队列') return finish();
    const timer = setInterval(() => {
      if (existsSync('release-queue')) {
        clearInterval(timer);
        finish();
      }
    }, 10);
  });
`;

test('enabled groups keep their own Codex threads and receive only their own results', { timeout: 15_000 }, async t => {
  const home = await realpath(await mkdtemp('/tmp/wx-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataDir = join(home, 'Library', 'Application Support', 'WeCom Codex');
  const sdkDir = join(home, 'node_modules', '@wecom', 'aibot-node-sdk');
  const codex = join(home, 'codex');
  const stateFile = join(dataDir, 'state.json');
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(sdkDir, { recursive: true })]);
  await Promise.all([
    cp(new URL('../wecom-codex/runtime', import.meta.url), join(home, 'runtime'), { recursive: true }),
    writeFile(codex, appServer, { mode: 0o700 }),
    writeFile(join(sdkDir, 'package.json'), JSON.stringify({ exports: './index.mjs' })),
    writeFile(join(sdkDir, 'index.mjs'), sdk),
    writeFile(join(dataDir, 'config.json'), JSON.stringify({ botId: 'test', secret: 'fixture-only', workspace: home, codex })),
    writeFile(stateFile, JSON.stringify({
      botId: 'test', workspace: home, owner: 'paired', thread: 'existing-private', seen: [], notices: [],
    })),
  ]);
  const child = spawn(process.execPath, [join(home, 'runtime', 'bridge.mjs')], {
    env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const events = [];
  createInterface({ input: child.stdout }).on('line', line => events.push(JSON.parse(line)));

  async function waitFor(predicate) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const event = events.find(predicate);
      if (event) return event;
      if (child.exitCode !== null) break;
      await pause(10);
    }
    assert.fail(`Expected bridge event. Bridge stderr: ${stderr}`);
  }
  function send(id, content, chatId, user = 'paired') {
    const body = { msgid: id, chattype: chatId ? 'group' : 'single', chatid: chatId,
      from: { userid: user }, msgtype: 'text', text: { content } };
    child.stdin.write(`${JSON.stringify({ body, headers: { req_id: id } })}\n`);
  }
  async function command(id, content, group, sender = 'paired') {
    send(id, content, group, sender);
    return (await waitFor(event => event.type === 'reply' && event.id === id)).text;
  }
  async function result(id, content, expected, group, sender = 'paired') {
    send(id, content, group, sender);
    const event = await waitFor(item => item.type === 'message' && item.text.endsWith(` ${expected}`));
    assert.equal(event.to, group ?? sender);
    return event.text.slice(0, -expected.length - 1);
  }
  const setAccess = mode => writeFile(join(dataDir, 'member-access.json'), JSON.stringify(mode));
  const setPreferences = (persona, localNotices) =>
    writeFile(join(dataDir, 'preferences.json'), JSON.stringify({ persona, localNotices }));
  function hook(turnId, sessionId = 'local-desktop-thread') {
    return new Promise((resolve, reject) => {
      const client = request({ socketPath: join(dataDir, 'control.sock'), path: '/hook', method: 'POST' }, response => {
        let body = '';
        response.setEncoding('utf8').on('data', chunk => { body += chunk; });
        response.once('end', () => resolve(JSON.parse(body)));
      });
      client.once('error', reject);
      client.end(JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId, cwd: home }));
    });
  }

  try {
    await waitFor(event => event.type === 'ready');
    send('unauthorized-enable', '@机器人 /group-on', 'group-a', 'other');
    assert.match(await command('before', '@机器人 /ping', 'group-a'), /尚未启用/);
    assert.match(await command('enable-a', '@机器人 /group-on', 'group-a'), /本群已启用/);
    assert.match(await command('enable-b', '@企微 Codex\u2005/group-on', 'group-b'), /本群已启用/);
    assert.match(await command('ping', '@机器人 /ping', 'group-a'), /pong/);
    send('unauthorized-task', '@机器人 不允许执行', 'group-a', 'other');
    assert.equal(await result('private', '验证私聊', '验证私聊'), 'existing-private');
    const threadA = await result('a-first', '@机器人 验证群 A', '验证群 A', 'group-a');
    const threadB = await result('b-first', '@机器人 验证群 B', '验证群 B', 'group-b');
    assert.notEqual(threadA, 'existing-private');
    assert.notEqual(threadA, threadB);
    assert.equal(await result('a-next', '@机器人 继续群 A', '继续群 A', 'group-a'), threadA);
    send('reset-a', '@机器人 /new', 'group-a');
    await waitFor(event => event.type === 'message' && event.to === 'group-a' && event.text.includes('新会话'));
    assert.notEqual(await result('a-reset', '@机器人 重开群 A', '重开群 A', 'group-a'), threadA);
    assert.equal(await result('b-next', '@机器人 继续群 B', '继续群 B', 'group-b'), threadB);
    assert.match(await command('approve-in-group', '@机器人 /approve 123456', 'group-a'), /私聊/);
    assert.match(await command('disable-a', '@机器人 /group-off', 'group-a'), /已关闭/);
    assert.match(await command('after', '@机器人 不再执行', 'group-a'), /尚未启用/);
    assert.equal(await result('private-next', '继续私聊', '继续私聊'), 'existing-private');

    await setAccess(memberAccessModes.group);
    send('unauthorized-private', '群权限不能私聊', undefined, 'other');
    assert.match(await command('guest-group-ping', '@机器人 /ping', 'group-b', 'other'), /pong/);
    assert.equal(await result('guest-group', '@机器人 群成员验证任务', '群成员验证任务', 'group-b', 'other'), threadB);
    assert.match(await command('guest-reset-group', '@机器人 /new', 'group-b', 'other'), /只有配对账号/);
    send('unauthorized-disabled-group', '@机器人 未启用的群', 'group-a', 'other');

    await setAccess(memberAccessModes.all);
    const guest = await result('guest-dm', '首位成员私聊', '首位成员私聊', undefined, 'other');
    const second = await result('second-dm', '第二位成员私聊', '第二位成员私聊', undefined, 'second');
    assert.notEqual(guest, 'existing-private');
    assert.notEqual(guest, second);
    assert.equal(await result('guest-dm-next', '私聊续接', '私聊续接', undefined, 'other'), guest);
    assert.match(await command('guest-approve', '/approve 123456', undefined, 'other'), /配对账号/);
    assert.match(await command('occupy-queue', '占住队列'), /正在处理/);
    assert.match(await command('queued-guest', '@机器人 排队时被收回权限', 'group-b', 'other'), /按顺序处理/);
    await setAccess(memberAccessModes.owner);
    await writeFile(join(home, 'release-queue'), '');
    send('unauthorized-revoked-group', '@机器人 权限收回后群聊', 'group-b', 'other');
    send('unauthorized-revoked-dm', '权限收回后私聊', undefined, 'other');
    assert.equal(await result('owner-still-allowed', '本人权限仍有效', '本人权限仍有效'), 'existing-private');

    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(saved.thread, 'existing-private');
    assert.deepEqual(saved.groups, [{ chatId: 'group-b', thread: threadB }]);
    assert.deepEqual(saved.direct, [{ userId: 'other', thread: guest }, { userId: 'second', thread: second }]);
    assert.ok(events.every(event => !event.id?.startsWith('unauthorized') && !event.text?.includes('不允许执行')));
    assert.ok(events.every(event => !event.text?.includes('排队时被收回权限')));

    const persona = { style: 'custom', instructions: '称呼我为搭档' };
    await setPreferences(persona, false);
    assert.deepEqual(await hook('local-with-notices-disabled'), {});
    assert.equal(await result('persona-next', '人设下一轮生效', '人设下一轮生效'), 'existing-private');
    const context = JSON.parse(await readFile(join(home, 'last-turn-context.json'), 'utf8'))['wecom-codex-persona'];
    assert.equal(context.kind, 'application');
    assert.match(context.value, /称呼我为搭档/);
    await setPreferences({ style: 'default', instructions: '' }, true);
    assert.deepEqual(await hook('local-one'), { queued: true });
    const notice = await waitFor(event => event.type === 'message' && event.text.includes('Codex 已回复'));
    assert.equal(notice.to, 'paired');
    assert.match(notice.text, /插件设置优化\*\*\n本轮任务　改成通知弹窗 Secret=（已隐藏）\n工作区/u);
    assert.doesNotMatch(notice.text, /另一轮任务|test-only-value|敏感附件详情/);
    assert.deepEqual(await hook('local-one'), {});
    assert.deepEqual(await hook('wecom-turn', 'existing-private'), {});
  } finally {
    child.kill();
    await exited;
  }
});
