import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Until 0.3.0 the project was named Cooperation and kept its data in
// .cooperation. The directory moves once, before anything opens it; entries
// that already exist under .plexus are left where they are and reported.
export const LEGACY_DATA = '.cooperation';
const OLD_LABEL = '【Cooperation 会话消息】', NEW_LABEL = '【Plexus 会话消息】';

export function migrateLegacyData(root) {
  const legacy = join(root, LEGACY_DATA), current = join(root, '.plexus');
  if (!existsSync(legacy) || existsSync(join(current, 'management.sqlite'))) return { migrated: false, leftovers: [] };
  try {
    if (!existsSync(current)) renameSync(legacy, current);
    else for (const name of readdirSync(legacy)) if (!existsSync(join(current, name))) renameSync(join(legacy, name), join(current, name));
  } catch (error) {
    throw new Error(`无法把旧数据目录 ${LEGACY_DATA} 迁移到 .plexus（${error.code || error.message}）。请先关闭旧版服务和已接入的 Claude 面板后重试。`);
  }
  const leftovers = existsSync(legacy) ? readdirSync(legacy) : [];
  if (existsSync(legacy) && !leftovers.length) rmdirSync(legacy);
  renameDefaultLabel(join(current, 'prompt-settings.json'));
  return { migrated: true, leftovers };
}

// A saved prompt that still carries the old default label follows the rename;
// any other wording is the user's own and stays unchanged.
function renameDefaultLabel(filename) {
  let saved;
  try { saved = JSON.parse(readFileSync(filename, 'utf8')); } catch { return; }
  const messages = saved?.values?.messages;
  if (!messages) return;
  let changed = false;
  if (messages.claude?.label === OLD_LABEL) { messages.claude.label = NEW_LABEL; changed = true; }
  if (messages.opencode?.prefix?.startsWith(OLD_LABEL)) { messages.opencode.prefix = NEW_LABEL + messages.opencode.prefix.slice(OLD_LABEL.length); changed = true; }
  if (!changed) return;
  const next = { ...saved, revision: (saved.revision || 0) + 1, updatedAt: new Date().toISOString() };
  writeFileSync(filename + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); renameSync(filename + '.tmp', filename);
}
