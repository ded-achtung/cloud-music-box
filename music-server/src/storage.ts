import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import path from 'node:path';

export interface StorageEntry { key: string; size: number; fingerprint: string }
export interface OpenedObject {
  size: number; fingerprint: string;
  stream(options?: { start?: number; end?: number; autoClose?: boolean }): Readable;
  unchanged(): Promise<boolean>;
  close(): Promise<void>;
}
export interface StorageAdapter {
  readonly sourceId: string;
  list(): AsyncIterable<StorageEntry>;
  open(key: string): Promise<OpenedObject>;
}

export const formats: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
};

// Verify the opened descriptor itself via procfs, so replacing a parent directory
// with a symlink between path validation and open cannot escape the root.
export class LocalStorage implements StorageAdapter {
  readonly sourceId = 'local';
  private constructor(private readonly root: string) {}
  static async create(root: string): Promise<LocalStorage> {
    if (process.platform !== 'linux') throw new Error('LocalStorage requires Linux /proc/self/fd');
    const canonical = await realpath(root);
    const handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.close();
    return new LocalStorage(canonical);
  }
  async open(key: string): Promise<OpenedObject> {
    if (!key || path.isAbsolute(key) || key.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new Error('Invalid storage key');
    }
    const handle = await open(path.join(this.root, key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const resolved = await realpath(`/proc/self/fd/${handle.fd}`);
      const relative = path.relative(this.root, resolved);
      const stat = await handle.stat();
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !stat.isFile()) {
        throw new Error('File outside storage root');
      }
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      // Content check only: unlinking or renaming an open file changes its ctime, not its bytes.
      return { size: stat.size, fingerprint, stream: opts => handle.createReadStream(opts),
        unchanged: async () => { const s = await handle.stat(); return s.size === stat.size && s.mtimeMs === stat.mtimeMs; },
        close: () => handle.close() };
    } catch (error) { await handle.close(); throw error; }
  }
  async *list(): AsyncIterable<StorageEntry> {
    const walk = async function* (self: LocalStorage, directory: string): AsyncGenerator<StorageEntry> {
      const entries = await readdir(path.join(self.root, directory), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const key = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { yield* walk(self, key); continue; }
        if (!entry.isFile() || !formats[path.extname(key).toLowerCase()]) continue;
        const handle = await self.open(key);
        try {
          yield { key, size: handle.size, fingerprint: handle.fingerprint };
        } finally { await handle.close(); }
      }
    };
    yield* walk(this, '');
  }
}
