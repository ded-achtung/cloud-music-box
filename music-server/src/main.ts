import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Catalog } from './catalog.js';
import { LocalStorage } from './storage.js';
import { Library } from './library.js';
import { buildApp } from './app.js';

const root = process.env.MUSIC_ROOT;
if (!root) throw new Error('Set MUSIC_ROOT to an existing music directory');
const dbPath = path.resolve(process.env.MUSIC_DB || './data/catalog.sqlite');
await mkdir(path.dirname(dbPath), {recursive:true, mode:0o700});
const port = Number(process.env.PORT || '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const interval = Number(process.env.MUSIC_SCAN_INTERVAL_SECONDS ?? '900');
if (!Number.isInteger(interval) || interval < 0) throw new Error('Invalid MUSIC_SCAN_INTERVAL_SECONDS');
const storage = await LocalStorage.create(root);
const catalog = new Catalog(dbPath);
if (process.argv.includes('--scan')) {
  try { console.log('Library scan:', await catalog.scan(storage)); } finally { catalog.close(); }
} else {
  // Serve the existing catalogue at once; the startup scan and later rescans run in the background.
  const library = new Library(catalog,storage,{watchPath: process.env.MUSIC_WATCH === '0' ? undefined : storage.root, intervalMs: interval*1000});
  const app = buildApp(catalog,storage,library);
  app.addHook('onClose', async () => { await library.close(); catalog.close(); });
  const stop = () => { void app.close(); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  process.on('SIGHUP',() => { void library.requestScan(); });
  try { await app.listen({host: process.env.HOST || '127.0.0.1',port}); }
  catch (error) { catalog.close(); throw error; }
  void library.start();
}
