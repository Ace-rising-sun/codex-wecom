import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { configureBot, readBotSettings } from './bot-settings.mjs';
import { listHistory, openHistoryThread } from './history.mjs';
import { efforts, maxTaskTimeoutMinutes, memberAccessModes, personaLimit, personaStyles, readMemberAccess, readModelSettings,
  readPreferences, updateMemberAccess, updateModelSettings, updatePreferences } from './model-settings.mjs';

const serverInfo = { name: 'wecom-settings', version: '0.4.0' };
const resourceUri = 'ui://wecom-codex/settings';
const resource = { uri: resourceUri, name: '企微 Codex 设置', mimeType: 'text/html;profile=mcp-app' };
const historyUri = 'ui://wecom-codex/history';
const historyResource = { uri: historyUri, name: '企微 Codex 会话历史', mimeType: 'text/html;profile=mcp-app' };
const settings = { readTool: 'wecom.settings.read', updateTool: 'wecom.settings.update' };
const nativeSettings = { readTool: 'wecom.settings.entry', updateTool: settings.updateTool };
const opener = 'wecom.settings.open';
const historyView = 'wecom.history.view';
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const fields = {
  model: { type: 'string', title: '默认模型', description: '企微会话使用的模型 ID。', minLength: 1, maxLength: 128 },
  reasoningEffort: { type: 'string', title: '推理强度', enum: efforts },
  memberAccess: { type: 'string', title: '使用权限',
    description: '决定谁可以从企微向本机 Codex 派任务。群聊须先由配对账号启用。', enum: Object.values(memberAccessModes) },
  persona: { ...object({
    style: { type: 'string', oneOf: Object.entries(personaStyles).map(([key, style]) => ({ const: key, title: style.label })) },
    instructions: { type: 'string', maxLength: personaLimit },
  }), required: ['style', 'instructions'], title: '机器人人设' },
  localNotices: { type: 'boolean', title: '本机会话结束提醒' },
  taskTimeoutMinutes: { type: 'integer', title: '执行时限（分钟）', minimum: 0, maximum: maxTaskTimeoutMinutes },
};
const appOnly = { ui: { visibility: ['app'] } };
const tools = [
  {
    name: nativeSettings.readTool, title: '读取企微设置入口', inputSchema: object({}),
    outputSchema: { type: 'object', properties: { schema: { type: 'object' }, values: { type: 'object' },
      layout: { type: 'array', items: { type: 'object' } } }, required: ['schema', 'values', 'layout'] },
    annotations: { readOnlyHint: true }, _meta: appOnly,
  },
  {
    name: settings.readTool, title: '读取企微设置', inputSchema: object({}),
    outputSchema: { type: 'object', properties: { schema: { type: 'object' }, values: { type: 'object' } },
      required: ['schema', 'values'] },
    annotations: { readOnlyHint: true }, _meta: appOnly,
  },
  {
    name: settings.updateTool, title: '保存企微设置',
    inputSchema: { ...object({ set: { ...object(fields), minProperties: 1 } }), required: ['set'] },
    outputSchema: { type: 'object', properties: { values: { type: 'object' } }, required: ['values'] },
    annotations: { destructiveHint: false }, _meta: appOnly,
  },
  {
    name: opener, title: '打开设置',
    description: '打开 Codex 桌面端的企微配置表单，用于设置模型、执行、回复、通知、使用权限和机器人。',
    inputSchema: object({}),
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { visibility: ['model', 'app'], resourceUri },
      'openai/outputTemplate': resourceUri,
      'openai/ui': { entrypoints: [{ type: 'global' }] },
    },
  },
  {
    name: historyView, title: '会话历史',
    description: '查看本机企微 Codex 会话并打开原对话。',
    inputSchema: object({}),
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ['app'], resourceUri: historyUri }, 'openai/outputTemplate': historyUri },
  },
  {
    name: 'wecom.history.list', title: '读取企微会话历史',
    inputSchema: object({ cursor: { ...object({ updatedAt: { type: 'integer' }, id: { type: 'string' } }),
      required: ['updatedAt', 'id'] } }),
    annotations: { readOnlyHint: true }, _meta: appOnly,
  },
  {
    name: 'wecom.history.openThread', title: '打开原 Codex 会话',
    inputSchema: { ...object({ id: { type: 'string' } }), required: ['id'] },
    annotations: { destructiveHint: false }, _meta: appOnly,
  },
  {
    name: 'wecom.settings.botRead', title: '读取机器人配置', inputSchema: object({}),
    annotations: { readOnlyHint: true }, _meta: appOnly,
  },
  {
    name: 'wecom.settings.botSave', title: '保存机器人配置',
    inputSchema: { ...object({ botId: { type: 'string' }, workspace: { type: 'string' },
      token: { type: 'string' }, sealedSecret: { type: 'string' } }), required: ['botId', 'workspace', 'token'] },
    _meta: appOnly,
  },
];

const keys = new Map();
let savingBot = false;
let savingSettings = Promise.resolve();

async function readSettings() {
  const [model, memberAccess, preferences] = await Promise.all([readModelSettings(), readMemberAccess(), readPreferences()]);
  return { ...model, memberAccess, ...preferences };
}

function newCredentialKey() {
  const now = Date.now();
  for (const [token, value] of keys) if (value.expires <= now) keys.delete(token);
  if (keys.size >= 8) keys.delete(keys.keys().next().value);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const token = randomUUID();
  keys.set(token, { privateKey, expires: now + 600_000 });
  return { token, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

function readSecret({ token, sealedSecret = '' }) {
  const key = keys.get(token);
  if (!key || key.expires <= Date.now()) throw new Error('配置表单已过期，请刷新后重试。');
  if (!sealedSecret) {
    keys.delete(token);
    return '';
  }
  try {
    const encrypted = Buffer.from(sealedSecret, 'base64');
    if (encrypted.length !== 384) throw new Error();
    const decoded = privateDecrypt({ key: key.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256' }, encrypted);
    const secret = decoded.toString('utf8');
    decoded.fill(0);
    keys.delete(token);
    return secret;
  } catch {
    throw new Error('无法读取加密的 Secret，请刷新后重试。');
  }
}

async function callTool(name, args) {
  switch (name) {
    case nativeSettings.readTool: return {
      schema: { type: 'object', properties: {} }, values: {},
      layout: [{ kind: 'group', title: '企微 Codex', items: [
        { kind: 'tool', tool: opener }, { kind: 'tool', tool: historyView },
      ] }],
    };
    case settings.readTool: return { schema: { type: 'object', properties: fields }, values: await readSettings() };
    case settings.updateTool: {
      const changes = args.set;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('请选择要更新的企微设置。');
      const update = savingSettings.then(async () => {
        const keys = Object.keys(changes);
        if (Object.hasOwn(changes, 'memberAccess')) {
          if (keys.length !== 1) throw new Error('请单独保存使用权限。');
          await updateMemberAccess(changes.memberAccess);
        } else if (Object.hasOwn(changes, 'taskTimeoutMinutes')) {
          if (keys.length !== 1) throw new Error('请单独保存执行时限。');
          await updatePreferences(changes);
        } else if (keys.some(key => key === 'persona' || key === 'localNotices')) {
          if (keys.some(key => key !== 'persona' && key !== 'localNotices')) throw new Error('请单独保存回复与通知。');
          await updatePreferences(changes);
        } else {
          await updateModelSettings(changes);
        }
        return readSettings();
      });
      savingSettings = update.catch(() => {});
      return { values: await update };
    }
    case opener:
    case historyView: return { opened: true };
    case 'wecom.history.list': return listHistory(args.cursor);
    case 'wecom.history.openThread': return openHistoryThread(args.id);
    case 'wecom.settings.botRead': return { ...await readBotSettings(), ...newCredentialKey() };
    case 'wecom.settings.botSave': {
      if (savingBot) throw new Error('连接配置正在保存，请稍后再试。');
      savingBot = true;
      try {
        return await configureBot({ botId: args.botId, workspace: args.workspace, secret: readSecret(args) });
      } finally {
        savingBot = false;
      }
    }
    default: throw new Error('未知的设置操作。');
  }
}

async function dispatch(method, params) {
  const extension = { 'openai/settings': nativeSettings };
  const capabilities = { tools: {}, resources: {}, extensions: extension };
  switch (method) {
    case 'server/discover': return {
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      capabilities,
    };
    case 'initialize': return { protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'].includes(params.protocolVersion)
      ? params.protocolVersion : '2025-11-25', serverInfo,
      capabilities: { ...capabilities, experimental: extension } };
    case 'ping': return {};
    case 'tools/list': return { tools };
    case 'resources/list': return { resources: [resource, historyResource] };
    case 'resources/templates/list': return { resourceTemplates: [] };
    case 'resources/read':
      if (params.uri === historyUri) {
        return { contents: [{ ...historyResource, text: await readFile(new URL('history.html', import.meta.url), 'utf8') }] };
      }
      if (params.uri !== resourceUri) throw new Error('找不到设置界面。');
      return { contents: [{ ...resource, text: await readFile(new URL('settings.html', import.meta.url), 'utf8') }] };
    case 'tools/call':
      try {
        const structuredContent = await callTool(params.name, params.arguments ?? {});
        return { content: [], structuredContent };
      } catch (error) {
        const known = typeof error.message === 'string' && /^[\p{Script=Han}]/u.test(error.message);
        return { isError: true, content: [{ type: 'text', text: known ? error.message : '无法更新本机企微配置。' }] };
      }
    default: throw Object.assign(new Error('不支持的 MCP 请求'), { code: -32601 });
  }
}

const rpc = createInterface({ input: process.stdin, crlfDelay: Infinity });
rpc.on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const { id, method, params = {} } = message;
  const response = { jsonrpc: '2.0', id };
  try { response.result = await dispatch(method, params); }
  catch (error) { response.error = { code: error.code ?? -32603, message: 'MCP 设置请求失败。' }; }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
