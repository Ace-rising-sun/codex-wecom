import { text } from 'node:stream/consumers';
import { control } from '../runtime/local.mjs';

try {
  await control('/hook', JSON.parse((await text(process.stdin)).replace(/^\uFEFF/u, '')), 2000);
} catch (error) {
  // A completion hook should not interrupt Codex while the bridge is offline.
  if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) {
    console.error('企微会话提醒投递失败。');
  }
}
console.log('{}');
