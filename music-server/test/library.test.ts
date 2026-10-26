import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Catalog } from '../src/catalog.js';
import { LocalStorage, type StorageAdapter } from '../src/storage.js';
import { Library } from '../src/library.js';
import { buildApp } from '../src/app.js';

function wav(samples = 8000): Buffer {
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF',0); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
  data.writeUInt32LE(8000,24); data.writeUInt32LE(16000,28); data.writeUInt16LE(2,32);
  data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(samples*2,40);
  return data;
}
// Wraps a storage adapter so a test can hold a scan in the middle of the traversal.
function gated(storage: StorageAdapter) {
  let release = () => {}, gate = Promise.resolve(), lists = 0;
  const adapter: StorageAdapter = { sourceId: storage.sourceId, open: key => storage.open(key),
    async *list() { lists++; for await (const entry of storage.list()) { await gate; yield entry; } } };
  return { adapter, lists: () => lists,
    block() { gate = new Promise<void>(resolve => { release = resolve; }); }, release: () => release() };
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(),'music-library-'));
  const music = path.join(dir,'music'); await mkdir(music);
  await writeFile(path.join(music,'a.wav'),wav()); await writeFile(path.join(music,'b.wav'),wav(6000));
  const storage = await LocalStorage.create(music), catalog = new Catalog(path.join(dir,'test.sqlite'));
  const logs: string[] = [];
  const cleanup = async (...closers: (() => Promise<void>)[]) => { for (const c of closers) await c(); catalog.close(); await rm(dir,{recursive:true,force:true}); };
  return { dir, music, storage, catalog, logs, log: (m: string) => { logs.push(m); }, cleanup };
}
const count = (c: Catalog) => (c.db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as {n:number}).n;
async function until(check: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(25)) if (check()) return;
  assert.ok(check(), 'condition not reached in time');
}

test('server answers while the startup scan is still running', async () => {
  const f = await fixture(); const g = gated(f.storage);
  const library = new Library(f.catalog,g.adapter,{log:f.log}); const app = buildApp(f.catalog,g.adapter,library);
  try {
    g.block(); const started = library.start();
    const during = (await app.inject({url:'/api/v1/server-info'})).json();
    assert.equal(during.library.scanning,true); assert.equal(during.capabilities.liveRescan,true);
    assert.deepEqual((await app.inject({url:'/api/v1/tracks'})).json().items,[]);
    g.release(); await started;
    const after = (await app.inject({url:'/api/v1/server-info'})).json();
    assert.equal(after.library.scanning,false); assert.equal(after.library.lastScanOk,true);
    assert.notEqual(after.library.revision,during.library.revision);
    assert.equal((await app.inject({url:'/api/v1/tracks'})).json().items.length,2);
  } finally { await f.cleanup(() => app.close(), () => library.close()); }
});

test('added, changed and deleted files are picked up without a restart', async () => {
  const f = await fixture();
  const library = new Library(f.catalog,f.storage,{watchPath:f.storage.root,debounceMs:50,log:f.log});
  try {
    await library.start(); assert.equal(count(f.catalog),2);
    const revision = library.status().revision;
    await mkdir(path.join(f.music,'New Album')); await writeFile(path.join(f.music,'New Album','c.wav'),wav(4000));
    // Tracks appear during the scan; the revision changes once the scan has finished.
    await until(() => count(f.catalog) === 3 && library.status().revision !== revision);
    await writeFile(path.join(f.music,'a.wav'),wav(2000));
    await until(() => (f.catalog.db.prepare("SELECT duration FROM tracks WHERE name='a.wav'").get() as {duration:number}).duration === 0.25);
    await rm(path.join(f.music,'b.wav'));
    await until(() => count(f.catalog) === 2);
  } finally { await f.cleanup(() => library.close()); }
});

test('periodic scans catch changes without a file watcher', async () => {
  const f = await fixture();
  const library = new Library(f.catalog,f.storage,{intervalMs:100,log:f.log});
  try {
    await library.start();
    await writeFile(path.join(f.music,'c.wav'),wav());
    await until(() => count(f.catalog) === 3);
  } finally { await f.cleanup(() => library.close()); }
});

test('requests during a scan collapse into one follow-up scan', async () => {
  const f = await fixture(); const g = gated(f.storage);
  const library = new Library(f.catalog,g.adapter,{log:f.log});
  try {
    g.block(); const first = library.start();
    const more = Array.from({length:5},() => library.requestScan());
    g.release(); await Promise.all([first,...more]);
    assert.equal(g.lists(),2); assert.equal(count(f.catalog),2);
  } finally { await f.cleanup(() => library.close()); }
});

test('a failed scan keeps the tracks and the next scan recovers', async () => {
  const f = await fixture();
  const library = new Library(f.catalog,f.storage,{log:f.log});
  try {
    await library.start(); assert.equal(count(f.catalog),2);
    await rename(f.music,path.join(f.dir,'away'));
    await library.requestScan();
    assert.equal(library.status().lastScanOk,false); assert.equal(count(f.catalog),2);
    assert.ok(f.logs.some(l => l.startsWith('Library scan failed')));
    await rename(path.join(f.dir,'away'),f.music);
    await library.requestScan();
    assert.equal(library.status().lastScanOk,true); assert.equal(count(f.catalog),2);
  } finally { await f.cleanup(() => library.close()); }
});

test('closing aborts a running scan without removing tracks', async () => {
  const f = await fixture(); const g = gated(f.storage);
  const library = new Library(f.catalog,g.adapter,{log:f.log});
  try {
    await library.start(); assert.equal(count(f.catalog),2);
    g.block(); const scan = library.requestScan();
    const closed = library.close(); g.release();
    await Promise.all([scan,closed]);
    assert.equal(count(f.catalog),2); assert.equal(library.status().scanning,false);
    assert.ok(!f.logs.some(l => l.startsWith('Library scan failed')));
    await library.requestScan(); assert.equal(g.lists(),2);
  } finally { await f.cleanup(); }
});
