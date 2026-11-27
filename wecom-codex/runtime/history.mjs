import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const originator = 'wecom_codex_local';
const threadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const pageSize = 30;
const updatedAt = 'COALESCE(updated_at_ms, updated_at * 1000)';
const wecomThread = 'originator = ? AND source IN (\'vscode\', \'cli\')';
const execFileAsync = promisify(execFile);

function defaultDirectory() {
  return process.env.CODEX_SQLITE_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
}

async function openIndex(directory) {
  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const name = files.filter(file => /^state_\d+\.sqlite$/u.test(file))
    .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))[0];
  return name ? new DatabaseSync(join(directory, name), { readOnly: true }) : null;
}

export async function listHistory(cursor, directory = defaultDirectory()) {
  if (cursor != null && (!Number.isSafeInteger(cursor.updatedAt) || cursor.updatedAt < 0
    || typeof cursor.id !== 'string' || !threadIdPattern.test(cursor.id))) {
    throw new Error('会话列表的翻页位置无效，请重新打开会话历史。');
  }
  const index = await openIndex(directory);
  if (!index) return { threads: [], nextCursor: null };
  try {
    const cursorFilter = cursor ? `AND (${updatedAt}, id) < (?, ?)` : '';
    const page = index.prepare(`
      SELECT id, COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(title), ''), '未命名会话') AS title,
             cwd, archived, ${updatedAt} AS updatedAt
      FROM threads
      WHERE ${wecomThread} ${cursorFilter}
      ORDER BY updatedAt DESC, id DESC
      LIMIT ?
    `).all(originator, ...(cursor ? [cursor.updatedAt, cursor.id] : []), pageSize + 1);
    const threads = page.slice(0, pageSize).map(row => ({
      id: row.id,
      title: row.title.replace(/\s+/gu, ' ').slice(0, 160),
      workspace: basename(row.cwd),
      archived: Boolean(row.archived),
      updatedAt: row.updatedAt,
    }));
    const last = threads.at(-1);
    return { threads, nextCursor: page.length > pageSize ? { id: last.id, updatedAt: last.updatedAt } : null };
  } finally {
    index.close();
  }
}

export async function openHistoryThread(id, directory = defaultDirectory(), launch = execFileAsync) {
  if (typeof id !== 'string' || !threadIdPattern.test(id)) throw new Error('会话标识无效。');
  const index = await openIndex(directory);
  let thread;
  try {
    thread = index?.prepare(`SELECT id FROM threads WHERE ${wecomThread} AND id = ?`).get(originator, id);
  } finally {
    index?.close();
  }
  if (!thread) throw new Error('这条企微会话已不在本机历史中，请重新打开列表。');
  try {
    await launch('/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${thread.id}`], { timeout: 5_000 });
  } catch {
    throw new Error('无法打开 Codex 会话，请确认桌面端已安装。');
  }
  return { opened: true };
}
