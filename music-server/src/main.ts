import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Catalog } from './catalog.js';
import { LocalStorage } from './storage.js';
import { buildApp } from './app.js';

const root = process.env.MUSIC_ROOT;
if (!root) throw new Error('Set MUSIC_ROOT to an existing music directory');
const dbPath = path.resolve(process.env.MUSIC_DB || './data/catalog.sqlite');
await mkdir(path.dirname(dbPath), {recursive:true, mode:0o700});
const port = Number(process.env.PORT || '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const storage = await LocalStorage.create(root);
const catalog = new Catalog(dbPath);
try {
  const result = await catalog.scan(storage);
  console.log('Library scan:', result);
  if (process.argv.includes('--scan')) { catalog.close(); }
  else {
    const app = buildApp(catalog,storage);
    app.addHook('onClose', async () => catalog.close());
    const stop = () => { void app.close(); };
    process.once('SIGINT',stop); process.once('SIGTERM',stop);
    await app.listen({host: process.env.HOST || '127.0.0.1',port});
  }
} catch (error) { catalog.close(); throw error; }
