import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { memberAccessModes } from '../wecom-codex/runtime/model-settings.mjs';

test('the settings server supports modern discovery and legacy initialization', () => {
  const server = fileURLToPath(new URL('../wecom-codex/runtime/settings-server.mjs', import.meta.url));
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'ui://wecom-codex/settings' } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wecom.settings.entry', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'ui://wecom-codex/history' } },
  ];
  const processResult = spawnSync(process.execPath, [server], {
    input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(processResult.status, 0, processResult.stderr || processResult.error?.message);
  const replies = processResult.stdout.trim().split('\n').map(line => JSON.parse(line));
  const discovery = replies.find(reply => reply.id === 1).result;
  const legacy = replies.find(reply => reply.id === 2).result;
  assert.equal(discovery.resultType, 'complete');
  assert.ok(discovery.supportedVersions.includes('2026-07-28'));
  assert.equal(discovery.ttlMs, 0);
  assert.equal(discovery.cacheScope, 'private');
  assert.deepEqual(discovery._meta['io.modelcontextprotocol/serverInfo'], legacy.serverInfo);
  assert.equal(legacy.protocolVersion, '2025-11-25');
  const native = discovery.capabilities.extensions['openai/settings'];
  assert.deepEqual(native, { readTool: 'wecom.settings.entry', updateTool: 'wecom.settings.update' });
  assert.deepEqual(legacy.capabilities.extensions, discovery.capabilities.extensions);
  const tools = replies.find(reply => reply.id === 3).result.tools;
  const launcher = tools.find(tool => tool.name === 'wecom.settings.open');
  assert.equal(launcher.title, '打开设置');
  assert.ok(!tools.some(tool => tool._meta?.['openai/ui']?.entrypoints?.some(entry => entry.type === 'settings')));
  const entry = replies.find(reply => reply.id === 5).result.structuredContent;
  assert.deepEqual(entry.schema.properties, {});
  assert.deepEqual(entry.values, {});
  const history = tools.find(tool => tool.name === 'wecom.history.view');
  assert.deepEqual(entry.layout.flatMap(group => group.items), [
    { kind: 'tool', tool: launcher.name }, { kind: 'tool', tool: history.name },
  ]);
  const resource = replies.find(reply => reply.id === 4).result.contents[0];
  assert.equal(resource.uri, launcher._meta.ui.resourceUri);
  assert.equal(resource.uri, launcher._meta['openai/outputTemplate']);
  for (const form of ['model-form', 'preferences-form', 'access-form', 'bot-form']) {
    assert.ok(resource.text.includes(`id="${form}"`));
  }
  const historyResource = replies.find(reply => reply.id === 6).result.contents[0];
  assert.equal(historyResource.uri, history._meta.ui.resourceUri);
  assert.ok(historyResource.text.includes('wecom.history.openThread'));
});

test('desktop settings save access, models, reply style and local notices', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wecom-access-settings-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const server = fileURLToPath(new URL('../wecom-codex/runtime/settings-server.mjs', import.meta.url));
  function call(name, args = {}) {
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
    const child = spawnSync(process.execPath, [server], {
      input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, HOME: home },
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return JSON.parse(child.stdout).result;
  }
  const initial = call('wecom.settings.read').structuredContent;
  assert.equal(initial.layout, undefined);
  assert.deepEqual(initial.schema.properties.memberAccess.enum, Object.values(memberAccessModes));
  assert.equal(initial.values.memberAccess, memberAccessModes.owner);
  for (const memberAccess of Object.values(memberAccessModes)) {
    const update = call('wecom.settings.update', { set: { memberAccess } });
    assert.equal(update.structuredContent.values.memberAccess, memberAccess);
    assert.equal(call('wecom.settings.read').structuredContent.values.memberAccess, memberAccess);
  }
  assert.equal(call('wecom.settings.update', { set: { memberAccess: 'unknown' } }).isError, true);
  const path = join(home, 'Library', 'Application Support', 'WeCom Codex', 'model.json');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  const update = call('wecom.settings.update', { set: { model: 'test-model' } });
  assert.equal(update.structuredContent.values.memberAccess, memberAccessModes.all);
  assert.equal(update.structuredContent.values.model, 'test-model');
  assert.equal(initial.values.localNotices, true);
  assert.deepEqual(initial.schema.properties.persona.properties.style.oneOf.map(choice => choice.const),
    ['default', 'professional', 'friendly', 'custom']);
  const persona = { style: 'custom', instructions: '先说结果，称呼我为搭档。' };
  const preferences = call('wecom.settings.update', { set: { persona, localNotices: false } }).structuredContent.values;
  assert.deepEqual(preferences.persona, persona);
  assert.equal(preferences.localNotices, false);
  assert.equal(preferences.model, 'test-model');
  assert.equal(call('wecom.settings.update', { set: { persona: { style: 'custom', instructions: '   ' } } }).isError, true);
  assert.equal(call('wecom.settings.update', { set: { localNotices: 'false' } }).isError, true);
  assert.deepEqual(call('wecom.settings.read').structuredContent.values, preferences);
});
