import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// An in-memory map that the manager can back with a file, so expensive scans
// survive a restart. Entries are validated by their callers on use; a missing
// or damaged file only costs a rescan. Other processes keep it in memory only.
export function persistedMap({ version = 1, delayMs = 2000 } = {}) {
  const map = new Map();
  let file = null, loading = null, timer = null;
  return {
    map,
    persistTo(filename) { file = filename; loading = null; },
    async load() {
      if (!file) return;
      loading ||= readFile(file, 'utf8').then(text => {
        const saved = JSON.parse(text);
        if (saved?.version !== version || !Array.isArray(saved.entries)) return;
        for (const [key, value] of saved.entries) if (typeof key === 'string' && !map.has(key)) map.set(key, value);
      }).catch(() => {});
      await loading;
    },
    saveSoon() {
      if (!file || timer) return;
      const target = file;
      timer = setTimeout(async () => {
        timer = null;
        const temporary = `${target}.${process.pid}.tmp`;
        try {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(temporary, JSON.stringify({ version, entries: [...map] }));
          await rename(temporary, target);
        } catch { /* Best effort; the next change writes again. */ }
      }, delayMs);
      timer.unref?.();
    },
  };
}
