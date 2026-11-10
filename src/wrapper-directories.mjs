import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeDirectory, containsDirectory } from './directory-service.mjs';

function scopes(config) {
  if (Object.hasOwn(config, 'directoryScopes')) return Array.isArray(config.directoryScopes)
    ? config.directoryScopes.filter(s => typeof s?.path === 'string' && s.path.trim() && typeof s.enabled === 'boolean')
      .map(s => ({ path: s.path, enabled: s.enabled, recursive: s.recursive === true })) : [];
  return (Array.isArray(config.directories) ? config.directories : []).filter(d => typeof d === 'string' && d.trim())
    .map(path => ({ path, enabled: true, recursive: false }));
}

export async function readWrapperDirectories(root) {
  try { const config = JSON.parse(await readFile(join(root, '.cooperation', 'claude-wrapper', 'config.json'), 'utf8'));
    return { enabled: config.enabled === true, directories: Array.isArray(config.directories) ? config.directories.filter(d => typeof d === 'string') : [],
      peerCrossModeAccept: config.peerCrossModeAccept === true,
      ...(Object.hasOwn(config, 'directoryScopes') ? { directoryScopes: scopes(config) } : {}) };
  } catch { return { enabled: false, directories: [] }; }
}
export function wrapperEnabledFor(config, path) {
  if (config.enabled !== true || !path) return false;
  let selected, specificity = -1;
  for (const scope of scopes(config)) {
    if (!containsDirectory(path, scope.path, scope.recursive)) continue;
    const length = normalizeDirectory(scope.path).length;
    if (length >= specificity) { selected = scope; specificity = length; }
  }
  return selected?.enabled === true;
}
export class WrapperDirectorySettings {
  constructor(root) { this.root = root; this.pending = Promise.resolve(); }
  change(update, { knownPaths = [], create = false, validate } = {}) {
    const operation = this.pending.then(async () => {
      const folder = join(this.root, '.cooperation', 'claude-wrapper');
      const filename = join(folder, 'config.json'); let source = {};
      try { source = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) return source; }
      const next = { ...source, ...update(scopes(source), source) };
      // Already running wrappers only understand exact paths. Keep that view
      // derived from the same rules, so old connections also observe revocation.
      const candidates = [...(Array.isArray(source.directories) ? source.directories : []), ...knownPaths, ...next.directoryScopes.map(s => s.path)]
        .filter(path => typeof path === 'string' && wrapperEnabledFor(next, path));
      next.directories = [...new Map(candidates.map(path => [normalizeDirectory(path), path])).values()];
      validate?.(next, source);
      if (JSON.stringify(source) === JSON.stringify(next)) return next;
      await mkdir(folder, { recursive: true });
      await writeFile(filename + '.tmp', JSON.stringify(next, null, 2) + '\n'); await rename(filename + '.tmp', filename); return next;
    });
    this.pending = operation.catch(() => {}); return operation;
  }
  // Running wrappers re-read this file on each status poll and apply it to
  // their own Claude process; no Claude settings file is written.
  setPeerCrossModeAccept(enabled) {
    const operation = this.pending.then(async () => {
      const folder = join(this.root, '.cooperation', 'claude-wrapper'), filename = join(folder, 'config.json');
      let source = {};
      try { source = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const next = { ...source, peerCrossModeAccept: enabled === true };
      if (source.peerCrossModeAccept === next.peerCrossModeAccept) return next;
      await mkdir(folder, { recursive: true });
      await writeFile(filename + '.tmp', JSON.stringify(next, null, 2) + '\n'); await rename(filename + '.tmp', filename); return next;
    });
    this.pending = operation.catch(() => {}); return operation;
  }
  set(path, enabled, { recursive = false, knownPaths = [], validate } = {}) {
    return this.change((rules, source) => ({ enabled: enabled ? true : source.enabled === true,
      directoryScopes: [...rules.filter(s => normalizeDirectory(s.path) !== normalizeDirectory(path)), { path, enabled, recursive }] }),
    { create: true, knownPaths, validate });
  }
  synchronize(directories, knownPaths = [], validate) {
    const byPath = new Map(directories.map(d => [normalizeDirectory(d.path), d]));
    return this.change(rules => ({ directoryScopes: rules.map(s => {
      const directory = byPath.get(normalizeDirectory(s.path)); return directory ? { ...s, recursive: directory.recursive === true } : s;
    }) }), { knownPaths: [...knownPaths, ...directories.map(d => d.path)], validate });
  }
  remove(path, knownPaths = [], validate) {
    return this.change(rules => ({ directoryScopes: rules.filter(s => normalizeDirectory(s.path) !== normalizeDirectory(path)) }), { knownPaths, validate });
  }
}
