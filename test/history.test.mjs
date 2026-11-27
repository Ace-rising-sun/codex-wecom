import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { listHistory, openHistoryThread } from '../wecom-codex/runtime/history.mjs';

test('history includes older and archived WeCom chats and opens only matching local chats', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wecom-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await listHistory(null, directory), { threads: [], nextCursor: null });

  const id = n => `019a113e-5f86-7e61-8b08-${n.toString(16).padStart(12, '0')}`;
  const database = new DatabaseSync(join(directory, 'state_5.sqlite'));
  try {
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, originator TEXT, source TEXT, name TEXT, title TEXT,
      cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER
    )`);
    const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let n = 1; n <= 32; n++) {
      insert.run(id(n), 'wecom_codex_local', 'vscode', n === 32 ? ' 显示标题 ' : null,
        `会话 ${n}`, '/workspace/project-a', 10, n === 2 ? null : 20_000, n === 1 ? 1 : 0);
    }
    insert.run(id(40), 'other-client', 'vscode', null, '另一个插件', '/workspace/other', 30, 30_000, 0);
    insert.run(id(41), 'wecom_codex_local', '{"subagent":{"other":"guardian"}}', null,
      '子代理', '/workspace/project-a', 30, 30_000, 0);
  } finally {
    database.close();
  }
  const first = await listHistory(null, directory);
  assert.equal(first.threads.length, 30);
  assert.deepEqual(first.threads[0], {
    id: id(32), title: '显示标题', workspace: 'project-a', archived: false, updatedAt: 20_000,
  });
  const second = await listHistory(first.nextCursor, directory);
  assert.deepEqual(second.threads.map(thread => thread.id), [id(1), id(2)]);
  assert.equal(second.threads[0].archived, true);
  assert.equal(second.nextCursor, null);

  const opens = [];
  const launch = (...args) => opens.push(args);
  assert.deepEqual(await openHistoryThread(id(1), directory, launch), { opened: true });
  assert.deepEqual(opens, [['/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${id(1)}`], { timeout: 5_000 }]]);
  await assert.rejects(openHistoryThread(id(40), directory, launch), /不在本机历史/);
  await assert.rejects(openHistoryThread('new?prompt=unrelated', directory, launch), /无效/);
  assert.equal(opens.length, 1);
});
