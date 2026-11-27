import { join } from 'node:path';
import { directory, prepareDirectory, readJson, saveJson } from './local.mjs';

export const defaultModelSettings = Object.freeze({ model: 'gpt-6.2-sol', reasoningEffort: 'high' });
export const efforts = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const memberAccessModes = Object.freeze({
  owner: '仅本人（可私聊和群聊）',
  group: '全部（本人可私聊和群聊，其他人仅群聊）',
  all: '全部（可私聊和群聊）',
});
const modelPattern = /^[\w][\w.\/:+-]{0,127}$/;
const file = join(directory, 'model.json');
const accessFile = join(directory, 'member-access.json');
const preferencesFile = join(directory, 'preferences.json');
export const personaStyles = Object.freeze({
  default: { label: '默认', instruction: '使用默认交流风格。以前轮次的企微人设已取消。' },
  professional: { label: '专业助手', instruction: '简洁、专业。先说结论，再按需要列出结果、证据和待处理事项。' },
  friendly: { label: '轻松搭档', instruction: '像熟悉的同事一样自然、轻松。称呼随和，偶尔用恰当的表情，关键结论保持清楚准确。' },
  custom: { label: '自定义' },
});
export const personaLimit = 600;
const defaultPreferences = { persona: { style: 'default', instructions: '' }, localNotices: true };

function validatePreferences(values) {
  const { persona, localNotices } = values;
  if (!persona || typeof persona.style !== 'string' || !Object.hasOwn(personaStyles, persona.style)
    || typeof persona.instructions !== 'string' || persona.instructions.length > personaLimit) {
    throw new Error('请选择有效的人设，自定义说明最多 600 字。');
  }
  const instructions = persona.instructions.trim();
  if (persona.style === 'custom' && !instructions) throw new Error('请填写自定义人设。');
  if (typeof localNotices !== 'boolean') throw new Error('请选择是否发送本机会话结束提醒。');
  return { persona: { style: persona.style, instructions }, localNotices };
}

export async function readPreferences() {
  return validatePreferences(await readJson(preferencesFile, defaultPreferences));
}

export async function updatePreferences(changes) {
  const values = validatePreferences({ ...await readPreferences(), ...changes });
  await prepareDirectory();
  await saveJson(preferencesFile, values);
  return values;
}

function validateMemberAccess(mode) {
  if (!Object.values(memberAccessModes).includes(mode)) throw new Error('请选择有效的企微使用权限。');
  return mode;
}

export async function readMemberAccess() {
  return validateMemberAccess(await readJson(accessFile, memberAccessModes.owner));
}

export async function updateMemberAccess(mode) {
  const value = validateMemberAccess(mode);
  await prepareDirectory();
  await saveJson(accessFile, value);
  return value;
}

function validate(values) {
  if (typeof values.model !== 'string' || !modelPattern.test(values.model)) {
    throw new Error('请填写有效的模型 ID。');
  }
  if (!efforts.includes(values.reasoningEffort)) throw new Error('请选择有效的推理强度。');
  return { model: values.model, reasoningEffort: values.reasoningEffort };
}

export async function readModelSettings(path = file) {
  return validate(await readJson(path, defaultModelSettings));
}

export async function updateModelSettings(changes, path = file) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length
    || Object.keys(changes).some(key => !Object.hasOwn(defaultModelSettings, key))) {
    throw new Error('请选择要更新的模型设置。');
  }
  const values = validate({ ...await readModelSettings(path), ...changes });
  if (path === file) await prepareDirectory();
  await saveJson(path, values);
  return values;
}
