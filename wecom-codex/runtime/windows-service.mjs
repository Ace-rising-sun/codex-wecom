import { Console } from 'node:console';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { directory } from './local.mjs';

const log = createWriteStream(join(directory, 'bridge.log'), { flags: 'a' });
const logger = new Console(log);
console.error = logger.error.bind(logger);
try {
  await import('./bridge.mjs');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
