import { createServer } from 'node:http';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { Codex } from './codex.mjs';
import { configFile, directory, isWindows, prepareDirectory, readJson, saveJson, socket, stateFile } from './local.mjs';
import { memberAccessModes, personaStyles, readMemberAccess, readModelSettings, readPreferences } from './model-settings.mjs';

const config = await readJson(configFile);
if (isWindows && !/^[a-f0-9]{64}$/.test(config.controlKey ?? '')) {
  throw new Error('Windows 后台缺少本机连接密钥。请重新运行安装程序。');
}
const controlAuthorization = isWindows ? Buffer.from(`Bearer ${config.controlKey}`) : undefined;
const previous = await readJson(stateFile, {});
const state = previous.botId === config.botId && previous.workspace === config.workspace
  ? previous : { botId: config.botId, workspace: config.workspace, seen: [], notices: [] };
state.groups ??= [];
state.direct ??= [];
let connected = false;
let pairing;
let codex;
const loadedThreads = new Set();
const concurrentTasks = 2;
const waitingLimit = 4;
const running = new Map();
const waiting = [];
const admissions = new Map();
const runsByThread = new Map();
const approvals = new Map();
let writing = Promise.resolve();
const limit = 20 * 1024 * 1024;
const approvalMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

function save() {
  const snapshot = structuredClone(state);
  writing = writing.catch(() => {}).then(() => saveJson(stateFile, snapshot));
  return writing;
}

function inside(root, file) {
  const name = relative(root, file);
  return !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`);
}

function bounded(value, maxBytes = 5500) {
  let result = '';
  let bytes = 0;
  for (const char of value) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) return `${result}\n…`;
    result += char;
  }
  return result;
}

const client = new WSClient({
  botId: config.botId,
  secret: config.secret,
  scene: 1,
  maxReconnectAttempts: -1,
  maxAuthFailureAttempts: 2,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
client.on('authenticated', () => { connected = true; console.error('企微长连接认证成功'); });
client.on('disconnected', () => { connected = false; });
client.on('error', error => console.error(`企微连接事件：${error.name}`));

function reply(frame, text) {
  return client.replyStream(frame, generateReqId('codex'), bounded(text), true);
}

async function notify(text, recipient = state.owner) {
  if (!connected || !state.owner) throw new Error('企微连接和私聊配对均就绪后才能发消息');
  await client.sendMessage(recipient, { msgtype: 'markdown', markdown: { content: bounded(text) } });
}

function noticePreview(value) {
  if (typeof value !== 'string') return '';
  const firstLine = value.trim().split(/[\r\n\u2028\u2029]/u, 1)[0].trim();
  const masked = firstLine
    .replace(/https?:\/\/\S+/giu, '（链接）')
    .replace(/((?:api[ _-]?key|bot[ _-]?secret|secret|token|password|密码|密钥)\s*[:=：]\s*|\bbearer\s+)\S+/giu, '$1（已隐藏）')
    .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|xox\w-[\w-]{16,})\b/gu, '（已隐藏）')
    .replace(/[@<>]/gu, char => ({ '@': '＠', '<': '＜', '>': '＞' })[char]);
  return bounded(masked, 240).replace(/\n…$/u, '…').replace(/[\\*_`\[\]]/gu, '\\$&');
}

async function notifyLocalTurn(threadId, turnId, cwd) {
  const app = await ensureCodex().catch(() => null);
  const [thread, turn] = app ? await Promise.all([
    app.request('thread/read', { threadId, includeTurns: false }).catch(() => undefined),
    app.request('thread/items/list', { threadId, turnId, limit: 8 }).catch(() => undefined),
  ]) : [];
  const title = noticePreview(thread?.thread?.name) || noticePreview(thread?.thread?.preview);
  const userMessage = turn?.data?.find(entry => entry.turnId === turnId && entry.item?.type === 'userMessage');
  const prompt = noticePreview(userMessage?.item.content?.find(item => item.type === 'text' && item.text?.trim())?.text);
  const lines = [title ? `**Codex 已回复 · ${title}**` : '**Codex 已回复**'];
  if (prompt && prompt !== title) lines.push(`本轮任务　${prompt}`);
  lines.push(`工作区　${noticePreview(basename(cwd))}`);
  if ((await readPreferences()).localNotices) await notify(lines.join('\n'));
}

async function memberMayUse(sender, isGroup) {
  if (!state.owner) return false;
  if (sender === state.owner) return true;
  const mode = await readMemberAccess();
  return mode === memberAccessModes.all || (isGroup && mode === memberAccessModes.group);
}

async function mayContinue(conversation, sender) {
  const isGroup = Boolean(conversation.chatId);
  return await memberMayUse(sender, isGroup) && (!isGroup || state.groups.includes(conversation));
}

async function handlePair(frame, code) {
  if (state.owner || !pairing || Date.now() > pairing.expires || code !== pairing.code) return;
  pairing = undefined;
  state.owner = frame.body.from.userid;
  await save();
  await reply(frame, '配对成功。发 /ping 检查连接，也可以直接发任务给 Codex。');
}

function clearApproval(run, pending) {
  if (run.approval !== pending) return false;
  clearTimeout(pending.timer);
  approvals.delete(pending.code);
  run.approval = undefined;
  return true;
}

function answerApproval(run, pending, accept) {
  if (!clearApproval(run, pending)) return false;
  const answer = pending.method === 'item/permissions/requestApproval'
    ? { permissions: accept ? pending.permissions ?? {} : {}, scope: 'turn' }
    : { decision: accept ? 'accept' : 'decline' };
  run.app.respond(pending.id, answer);
  return true;
}

function finishRun(run, status) {
  if (run.finished) return;
  run.finished = true;
  clearTimeout(run.timer);
  if (run.approval) clearApproval(run, run.approval);
  run.done.resolve(status);
}

function onCodexEvent(app, { id, method, params }) {
  const run = runsByThread.get(params?.threadId);
  const eventTurn = params?.turn?.id ?? params?.turnId;
  const matches = run?.app === app && !run.finished && (!run.turnId || !eventTurn || run.turnId === eventTurn);
  if (id !== undefined) {
    if (!approvalMethods.has(method)) {
      if (method === 'item/tool/requestUserInput') app.respond(id, { answers: {} });
      else if (method === 'mcpServer/elicitation/request') app.respond(id, { action: 'decline', content: null });
      else app.reject(id);
      return;
    }
    if (!matches || run.approval || run.stopReason) {
      app.respond(id, method === 'item/permissions/requestApproval'
        ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
      return;
    }
    let code;
    do {
      code = String(randomInt(100_000, 1_000_000));
    } while (approvals.has(code));
    const pending = { id, method, code, permissions: params.permissions, run };
    const decline = () => {
      try {
        answerApproval(run, pending, false);
      } catch {
        console.error('未能拒绝已过期的企微权限请求');
      }
    };
    pending.timer = setTimeout(decline, 90_000);
    run.approval = pending;
    approvals.set(code, pending);
    const detail = bounded(params.command ?? params.reason ?? '请确认 Codex 请求的一次性权限。', 1000);
    const context = run.job.group ? '群聊任务' : '私聊任务';
    const task = noticePreview(run.taskPreview);
    void mayContinue(run.job.conversation, run.job.sender).then(allowed => {
      if (run.approval !== pending) return;
      if (!allowed) return decline();
      return notify(`Codex 等待批准 · ${context}${task ? `\n任务　${task}` : ''}\n${detail}\n\n回复 /approve ${code} 或 /reject ${code}，90 秒内有效。`);
    }).catch(decline);
    return;
  }
  if (!matches) return;
  if (method === 'turn/started') beginRun(run, eventTurn);
  if (method === 'item/completed' && params.item.type === 'agentMessage' && params.item.phase !== 'commentary') {
    run.answer = params.item.text;
  }
  if (method === 'turn/completed') finishRun(run, params.turn.status);
}

async function ensureCodex() {
  if (!codex) {
    const instance = new Codex({
      executable: config.codex, directory: config.workspace,
      onEvent(event) {
        if (codex === instance) onCodexEvent(instance, event);
      },
      onExit(app) {
        if (codex !== app) return;
        codex = undefined;
        loadedThreads.clear();
        for (const run of runsByThread.values()) {
          if (run.app === app) finishRun(run, 'failed');
        }
      },
    });
    codex = instance;
  }
  const instance = codex;
  try {
    await instance.ready;
    return instance;
  } catch (error) {
    instance.close();
    throw error;
  }
}

async function sendInterrupt(run) {
  if (run.finished) return;
  try {
    if (run.approval) answerApproval(run, run.approval, false);
    await run.app.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
  } catch (error) {
    if (run.finished) return;
    run.stopReason = undefined;
    throw error;
  }
}

async function interrupt(run, reason = 'manual') {
  if (run.finished || run.stopReason) return;
  run.stopReason = reason;
  if (run.turnId) await sendInterrupt(run);
}

function beginRun(run, turnId) {
  if (!turnId || run.turnId || run.finished) return;
  run.turnId = turnId;
  if (run.stopReason) {
    void sendInterrupt(run).catch(() => console.error('未能停止企微任务'));
    return;
  }
  if (run.timeoutMinutes > 0) {
    run.timer = setTimeout(() => {
      void interrupt(run, 'timeout').catch(async () => {
        if (!run.finished) await publish(run.job, `本轮达到 ${run.timeoutMinutes} 分钟执行时限，暂未确认停止。`);
      }).catch(() => console.error('未能发送执行时限提示'));
    }, run.timeoutMinutes * 60_000);
  }
}

function withoutMention(text) {
  return text.replace(/^@[^@\r\n\u2005]+[\u2005\r\n]+\s*|^@\S+(?:\s+|$)/u, '').trim();
}

async function codexInput(frame, cleanText) {
  const message = frame.body;
  const items = [];
  const description = cleanText ?? message.text?.content ?? message.voice?.content ?? '';
  if (description) items.push({ type: 'text', text: description });
  const quoted = message.quote?.text?.content;
  if (quoted) items.push({ type: 'text', text: `引用消息：\n${quoted}` });
  const mixed = message.mixed?.msg_item ?? [];
  const media = [message.image ?? message.file ?? message.video, message.quote?.image ?? message.quote?.file,
    ...mixed.map(item => item.image)].filter(Boolean);
  for (const item of mixed) {
    if (item.text?.content) items.push({ type: 'text', text: item.text.content });
  }
  if (media.length > 4) throw new Error('一次最多接收四个附件');
  for (const item of media) {
    const { buffer, filename } = await client.downloadFile(item.url, item.aeskey);
    if (buffer.length > limit) throw new Error('单个附件超过 20 MiB');
    const root = join(directory, 'attachments');
    await mkdir(root, { mode: 0o700, recursive: true });
    const name = basename(filename || 'attachment').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 75);
    const path = join(root, `${generateReqId('attachment')}-${name}`);
    await writeFile(path, buffer, { mode: 0o600, flag: 'wx' });
    if (/\.(png|jpe?g|gif|webp)$/i.test(name) || item === message.image || mixed.some(part => part.image === item)) {
      items.push({ type: 'localImage', path });
    } else {
      items.push({ type: 'text', text: `企微附件已保存到本机，请按需读取 ${JSON.stringify(path)}。` });
    }
  }
  return items;
}

async function runTask(job, items) {
  const { conversation, sender, messageId } = job;
  const [{ model, reasoningEffort: effort }, { persona, taskTimeoutMinutes }] =
    await Promise.all([readModelSettings(), readPreferences()]);
  const instruction = persona.style === 'custom' ? persona.instructions : personaStyles[persona.style].instruction;
  const additionalContext = {
    'wecom-codex-persona': {
      kind: 'application',
      value: `本轮企微回复的人设如下，以它为准。只用于称呼、语气和表达方式。任务、权限和准确性要求照常。\n${instruction}`,
    },
  };
  const app = await ensureCodex();
  let threadId = conversation.thread;
  if (!threadId) {
    const created = await app.request('thread/start', {
      cwd: config.workspace, model, sandbox: 'read-only', approvalPolicy: 'on-request',
      serviceName: 'wecom-codex',
    });
    threadId = created.thread.id;
  } else if (!loadedThreads.has(threadId)) {
    await app.request('thread/resume', {
      threadId, model, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'on-request',
    });
    if (app === codex) loadedThreads.add(threadId);
  }

  if (!await mayContinue(conversation, sender)) return;
  if (app !== codex || runsByThread.has(threadId)) throw new Error('Codex 会话暂时不可用');
  const run = {
    job, app, threadId, timeoutMinutes: taskTimeoutMinutes, done: Promise.withResolvers(),
    taskPreview: items.find(item => item.type === 'text')?.text,
  };
  job.run = run;
  runsByThread.set(threadId, run);
  try {
    // Once a turn is submitted, only that turn's completion, interruption, or server exit ends it.
    const started = app.request('turn/start', {
      threadId, input: items, model, effort, clientUserMessageId: messageId, additionalContext,
    }, 0).then(result => beginRun(run, result.turn.id));
    await Promise.race([started, run.done.promise]);
    const status = await run.done.promise;
    if (!conversation.thread && status === 'completed' && await mayContinue(conversation, sender)) {
      conversation.thread = threadId;
      if (app === codex) loadedThreads.add(threadId);
      await save();
    }
    if (status === 'completed') return run.answer || '本轮已完成。';
    if (status === 'interrupted') return run.stopReason === 'timeout'
      ? `本轮达到设置的 ${run.timeoutMinutes} 分钟执行时限，已停止。` : '任务已停止。';
    return 'Codex 本轮执行失败。';
  } finally {
    finishRun(run, 'failed');
    runsByThread.delete(threadId);
  }
}

async function publish(job, result) {
  if (await mayContinue(job.conversation, job.sender)) await notify(result, job.group?.chatId ?? job.sender);
}

async function executeJob(job) {
  const { conversation, sender, group, frame, text } = job;
  if (!await mayContinue(conversation, sender)) return;
  if (text === '/new') {
    loadedThreads.delete(conversation.thread);
    delete conversation.thread;
    await save();
    const result = '下条消息将从新会话开始。';
    return group ? publish(job, result) : reply(frame, result);
  }
  await job.groupAck;
  const items = await codexInput(frame, group && frame.body.text ? text : undefined);
  if (!items.length) {
    const result = '请发送文字、截图或附件。';
    return group ? publish(job, result) : reply(frame, result);
  }
  if (!await mayContinue(conversation, sender)) return;
  if (!group) await reply(frame, '已接收，Codex 正在处理。');
  const result = await runTask(job, items);
  if (result !== undefined) await publish(job, result).catch(() => console.error('企微任务结果发送失败'));
}

function dispatchJobs() {
  while (running.size < concurrentTasks) {
    const index = waiting.findIndex(job => !running.has(job.key));
    if (index < 0) return;
    const [job] = waiting.splice(index, 1);
    running.set(job.key, job);
    void executeJob(job).catch(async error => {
      console.error(`处理任务失败：${error.name}`);
      await publish(job, '这次任务未能完成，可以发送 /status 检查连接。').catch(() => {});
    }).finally(() => {
      running.delete(job.key);
      dispatchJobs();
    });
  }
}

async function sendFile(path) {
  if (!path || isAbsolute(path)) throw new Error('请填写工作目录中的相对路径');
  const absolute = await realpath(join(config.workspace, path));
  const info = await stat(absolute);
  if (!inside(config.workspace, absolute) || !info.isFile() || info.size > limit) {
    throw new Error('仅可发送工作目录内不超过 20 MiB 的普通文件');
  }
  const data = await readFile(absolute);
  if (data.length > limit) throw new Error('附件超过 20 MiB');
  const uploaded = await client.uploadMedia(data, { type: 'file', filename: basename(absolute) });
  await client.sendMediaMessage(state.owner, 'file', uploaded.media_id);
}

async function receive(frame, key) {
  const message = frame.body;
  if (typeof message?.from?.userid !== 'string' || !message.from.userid
    || typeof message.msgid !== 'string' || !message.msgid) return;
  const isGroup = message.chattype === 'group';
  if (isGroup ? typeof message.chatid !== 'string' || !message.chatid : message.chattype !== 'single') return;
  const content = message.text?.content?.trim() ?? '';
  const text = isGroup ? withoutMention(content) : content;
  const sender = message.from.userid;
  const isOwner = sender === state.owner;
  const pair = isGroup ? null : /^\/pair (\d{8})$/.exec(text);
  if (pair) return handlePair(frame, pair[1]);
  if (!await memberMayUse(sender, isGroup)) return;
  const group = isGroup ? state.groups.find(item => item.chatId === message.chatid) : undefined;
  if ((!isOwner && isGroup && !group) || state.seen.includes(message.msgid)) return;
  state.seen = [...state.seen.slice(-255), message.msgid];
  if (isGroup && !isOwner && ['/group-on', '/group-off', '/new'].includes(text)) {
    await save();
    return reply(frame, '只有配对账号可以管理本群的 Codex 会话。');
  }
  if (isGroup && text === '/group-on') {
    if (!group) state.groups.push({ chatId: message.chatid });
    await save();
    return reply(frame, '本群已启用企微 Codex。可派任务的成员由插件的使用权限决定，结果对本群成员可见。');
  }
  if (isGroup && text === '/group-off') {
    if (group) {
      state.groups.splice(state.groups.indexOf(group), 1);
      loadedThreads.delete(group.thread);
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (waiting[i].key === key) waiting.splice(i, 1);
      }
      const run = running.get(key)?.run;
      if (run) void interrupt(run).catch(() => console.error('未能停止已关闭群聊的任务'));
    }
    await save();
    return reply(frame, '本群已关闭企微 Codex。');
  }
  if (isGroup && !group) {
    await save();
    return reply(frame, '本群尚未启用。由已配对账号 @ 机器人发送 /group-on 开启，任务结果将发到本群。');
  }
  await save();

  let conversation = group ?? (isOwner ? state : state.direct.find(item => item.userId === sender));
  if (text === '/ping') return reply(frame, 'pong · 企微 Codex 在线');
  const activeJob = running.get(key);
  if (text === '/status') {
    const queued = waiting.filter(job => job.key === key).length;
    const summary = `${activeJob ? '本会话正在运行' : '本会话空闲'}，等待任务 ${queued} 个。`;
    return reply(frame, !group && isOwner
      ? `${summary}全部企微会话运行中 ${running.size} 个，等待 ${waiting.length} 个。` : summary);
  }
  if (text === '/stop') {
    const run = activeJob?.run;
    if (!run || run.finished || (!isOwner && activeJob.sender !== sender)) {
      return reply(frame, '当前没有可停止的运行中任务。');
    }
    await interrupt(run);
    return reply(frame, '已请求停止当前任务。');
  }
  const decision = /^\/(approve|reject) (\d{6})$/.exec(text);
  if (decision) {
    if (group || !isOwner) return reply(frame, '权限审批请由配对账号在机器人私聊中处理。');
    const pending = approvals.get(decision[2]);
    if (!pending) return reply(frame, '审批请求不存在或已过期。');
    const { run } = pending;
    const accept = decision[1] === 'approve' && await mayContinue(run.job.conversation, run.job.sender);
    if (!answerApproval(run, pending, accept)) return reply(frame, '审批请求不存在或已过期。');
    return reply(frame, '已记录一次性审批。');
  }
  if (!group && isOwner && text.startsWith('/file ')) {
    await sendFile(text.slice(6).trim());
    return;
  }
  if (text.startsWith('/') && text !== '/new') {
    return reply(frame, group ? '本群支持 /ping、/status、/new、/stop 和 /group-off。'
      : isOwner ? '支持 /ping、/status、/new、/stop 和 /file 相对路径。' : '支持 /ping、/status、/new 和 /stop。');
  }
  if (waiting.length >= waitingLimit && (running.size >= concurrentTasks || activeJob)) {
    return reply(frame, '等待队列已满，请稍后再发。');
  }
  if (!conversation) {
    conversation = { userId: sender };
    state.direct.push(conversation);
  }
  const groupAck = group && text !== '/new'
    ? reply(frame, '已接收，本会话按顺序处理。').catch(() => console.error('企微群聊确认回复失败'))
    : undefined;
  waiting.push({ key, conversation, sender, messageId: message.msgid, group, frame, text, groupAck });
  dispatchJobs();
}

client.on('message', frame => {
  const message = frame?.body;
  const isGroup = message?.chattype === 'group';
  const id = isGroup ? message.chatid : message?.from?.userid;
  if (typeof id !== 'string' || !id) return;
  const key = `${isGroup ? 'group' : 'private'}:${id}`;
  const admission = (admissions.get(key) ?? Promise.resolve()).then(() => receive(frame, key))
    .catch(() => console.error('未能处理企微消息'));
  admissions.set(key, admission);
  void admission.finally(() => {
    if (admissions.get(key) === admission) admissions.delete(key);
  });
});

async function handleRequest(req) {
  if (req.method === 'GET' && req.url === '/status') {
    return { connected, paired: Boolean(state.owner), active: running.size > 0, waiting: waiting.length };
  }
  if (req.method !== 'POST') throw new Error('请求不受支持');
  let body = '';
  for await (const data of req.setEncoding('utf8')) {
    body += data;
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error('本地请求过大');
  }
  const input = JSON.parse(body);
  if (req.url === '/pair') {
    if (state.owner) throw new Error('机器人已配对');
    if (!pairing || Date.now() > pairing.expires) {
      pairing = { code: String(randomInt(10_000_000, 100_000_000)), expires: Date.now() + 600_000 };
    }
    return { command: `/pair ${pairing.code}` };
  }
  if (req.url === '/notice' && typeof input.message === 'string') {
    await notify(input.message);
    return { sent: true };
  }
  if (req.url === '/hook') {
    if (!state.owner || !connected || input.hook_event_name !== 'Stop' || input.stop_hook_active
      || !input.turn_id || !input.session_id || input.session_id === state.thread || runsByThread.has(input.session_id)
      || state.groups.some(group => group.thread === input.session_id)
      || state.direct.some(direct => direct.thread === input.session_id) || typeof input.cwd !== 'string') return {};
    const cwd = await realpath(input.cwd).catch(() => undefined);
    const key = `${input.session_id}:${input.turn_id}`;
    if (!cwd || !inside(config.workspace, cwd) || !(await readPreferences()).localNotices || state.notices.includes(key)) return {};
    state.notices = [...state.notices.slice(-255), key];
    await save();
    void notifyLocalTurn(input.session_id, input.turn_id, cwd).catch(() => console.error('本机任务通知发送失败'));
    return { queued: true };
  }
  throw new Error('请求不受支持');
}

await prepareDirectory();
if (!isWindows) await rm(socket, { force: true });
const control = createServer((req, res) => {
  if (controlAuthorization) {
    const provided = Buffer.from(req.headers.authorization ?? '');
    if (provided.length !== controlAuthorization.length || !timingSafeEqual(provided, controlAuthorization)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '本机连接未授权' }));
      return;
    }
  }
  handleRequest(req).then(reply => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  }).catch(error => {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
  });
});
await new Promise((resolve, reject) => control.once('error', reject).listen(socket, resolve));
if (!isWindows) await chmod(socket, 0o600);
client.connect();
process.on('SIGTERM', () => {
  client.disconnect();
  codex?.close();
  control.close(() => process.exit(0));
});
