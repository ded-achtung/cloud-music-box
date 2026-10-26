import { watch, type FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Catalog } from './catalog.js';
import type { StorageAdapter } from './storage.js';

export interface LibraryOptions {
  watchPath?: string; debounceMs?: number; intervalMs?: number;
  log?: (message: string, detail?: unknown) => void;
}
export interface LibraryStatus { scanning: boolean; revision: string; lastScanAt: string | null; lastScanOk: boolean | null }

// Keeps the catalogue in sync while the server runs. Only one scan runs at a time;
// requests made during a scan collapse into a single follow-up scan.
export class Library {
  private running: Promise<void> | null = null;
  private again = false;
  private changes = 0;
  private readonly boot = randomUUID().slice(0, 8);
  private readonly abort = new AbortController();
  private timer?: NodeJS.Timeout; private interval?: NodeJS.Timeout; private watcher?: FSWatcher;
  private state = { scanning: false, lastScanAt: null as string | null, lastScanOk: null as boolean | null };
  constructor(private readonly catalog: Catalog, private readonly storage: StorageAdapter, private readonly options: LibraryOptions = {}) {}
  // Revision is opaque: clients compare it for equality to know when to reload the catalogue.
  status(): LibraryStatus { return { ...this.state, revision: `${this.boot}-${this.changes}` }; }
  start(): Promise<void> {
    const { watchPath, debounceMs = 3000, intervalMs = 0 } = this.options;
    if (watchPath) {
      // Events keep arriving while a file is being copied; scan once the folder is quiet.
      try {
        this.watcher = watch(watchPath, { recursive: true }, () => this.schedule(debounceMs));
        this.watcher.on('error', error => { this.log('File watcher stopped; relying on periodic scans', error); this.watcher?.close(); this.watcher = undefined; });
      } catch (error) { this.log('File watcher unavailable; relying on periodic scans', error); }
    }
    if (intervalMs > 0) { this.interval = setInterval(() => void this.requestScan(), intervalMs); this.interval.unref(); }
    return this.requestScan();
  }
  requestScan(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = this.loop().finally(() => { this.running = null; });
    return this.running;
  }
  async close() {
    this.abort.abort();
    clearTimeout(this.timer); clearInterval(this.interval); this.watcher?.close();
    await this.running;
  }
  private schedule(ms: number) {
    if (this.abort.signal.aborted) return;
    clearTimeout(this.timer); this.timer = setTimeout(() => void this.requestScan(), ms); this.timer.unref();
  }
  private async loop() {
    do {
      this.again = false; this.state.scanning = true;
      try {
        const result = await this.catalog.scan(this.storage, this.abort.signal);
        this.state.lastScanAt = new Date().toISOString(); this.state.lastScanOk = true;
        if (result.added || result.updated || result.removed) this.changes++;
        this.log('Library scan:', result);
      } catch (error) {
        if (this.abort.signal.aborted) break;
        // A failed scan may still have indexed some files before it stopped.
        this.state.lastScanAt = new Date().toISOString(); this.state.lastScanOk = false; this.changes++;
        this.log('Library scan failed; no tracks were removed:', error);
      } finally { this.state.scanning = false; }
    } while (this.again && !this.abort.signal.aborted);
  }
  private log(message: string, detail?: unknown) { (this.options.log ?? console.log)(message, detail); }
}
