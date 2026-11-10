import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// One index per wrapper folder, shared by every ClaudeRuntime in the process.
// Offline sessions are answered from it instead of each session re-reading
// every record on every sample. Wrappers replace their record by rename, so a
// folder mtime change means records changed; a short age bounds anything else.
const indexes = new Map();
const MAX_AGE_MS = 1000;
const OWNED = /^(\d+)-[0-9a-f-]{36}\.json(\.tmp)?$/i;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

class InstanceRegistry {
  constructor(folder) { this.folder = folder; this.files = new Map(); this.list = []; this.at = 0; this.folderTime = null; this.scanning = null; }
  async records() {
    if (Date.now() - this.at < MAX_AGE_MS && await this.folderModified() === this.folderTime) return this.list;
    if (!this.scanning) this.scanning = this.scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  folderModified() { return stat(this.folder).then(info => info.mtimeMs, () => null); }
  async scan() {
    let folderTime = await this.folderModified(), removed = false;
    const seen = new Set(), remove = async filename => { removed = true; await unlink(filename).catch(() => {}); };
    for (const name of await readdir(this.folder).catch(() => [])) {
      const filename = join(this.folder, name), owner = OWNED.exec(name);
      // A wrapper killed together with its panel never removes its record.
      // Only records whose wrapper or Claude process has exited are deleted.
      if (owner && !alive(Number(owner[1]))) { await remove(filename); continue; }
      if (!name.endsWith('.json')) continue;
      try {
        const info = await stat(filename);
        let entry = this.files.get(name);
        if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size)
          entry = { mtimeMs: info.mtimeMs, size: info.size, record: JSON.parse(await readFile(filename, 'utf8')) };
        if (owner && entry.record.childPid && !alive(entry.record.childPid)) { await remove(filename); continue; }
        this.files.set(name, entry); seen.add(name);
      } catch { /* Replaced or removed during the scan; the next scan sees it. */ }
    }
    // Our own deletions changed the folder time; a write racing them is still
    // picked up once the index ages out.
    if (removed) folderTime = await this.folderModified();
    for (const name of this.files.keys()) if (!seen.has(name)) this.files.delete(name);
    this.list = [...this.files.values()].map(entry => entry.record);
    this.at = Date.now(); this.folderTime = folderTime;
    return this.list;
  }
}

export function instanceRecords(folder) {
  if (!indexes.has(folder)) indexes.set(folder, new InstanceRegistry(folder));
  return indexes.get(folder).records();
}
