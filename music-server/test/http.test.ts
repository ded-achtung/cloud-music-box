import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, rename, readdir, readlink } from 'node:fs/promises';
import { readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Catalog } from '../src/catalog.js';
import { VersionCache } from '../src/version-cache.js';
import { LocalStorage, type StorageAdapter } from '../src/storage.js';
import { buildApp } from '../src/app.js';

function wav(fill: number, bytes = 8 * 1024 * 1024): Buffer {
  const b = Buffer.alloc(44 + bytes, fill);
  b.write('RIFF',0); b.writeUInt32LE(b.length - 8,4); b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24); b.writeUInt32LE(16000,28); b.writeUInt16LE(2,32);
  b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(bytes,40);
  return b;
}
async function start(cacheMax = 1024*1024*1024) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'music-http-test-'));
  const root=path.join(dir,'music'); await mkdir(root);
  const a=wav(0x2a), b=wav(0x7b);
  await writeFile(path.join(root,'a.wav'),a); await writeFile(path.join(root,'b.wav'),b);
  const storage=await LocalStorage.create(root), catalog=new Catalog(path.join(dir,'catalog.sqlite'));
  await catalog.scan(storage);
  const cache=await VersionCache.open(path.join(dir,'cache'),cacheMax);
  const app=buildApp(catalog,storage,cache); const base=await app.listen({host:'127.0.0.1',port:0});
  const tracks=catalog.db.prepare('SELECT id,name FROM tracks ORDER BY name').all() as unknown as {id:string;name:string}[];
  return {dir,root,a,b,storage,catalog,app,cache,base,tracks,cleanup:async()=>{await app.close();await cache.close();catalog.close();await rm(dir,{recursive:true,force:true});}};
}
function get(base: string, route: string, headers: Record<string,string> = {}): Promise<IncomingMessage> {
  return new Promise((resolve,reject)=>{const req=request(new URL(route,base),{headers,agent:false},resolve);req.on('error',reject);req.end();});
}
async function body(res: IncomingMessage): Promise<Buffer> { const parts: Buffer[]=[]; for await (const c of res) parts.push(Buffer.from(c)); return Buffer.concat(parts); }
async function musicDescriptors(root: string): Promise<string[]> {
  const names=await readdir('/proc/self/fd');
  const targets=await Promise.all(names.map(async n=>readlink(`/proc/self/fd/${n}`).catch(()=>'')));
  return targets.filter(s=>s.startsWith(root + '/') || s.includes('/cache/'));
}
async function assertNoDescriptors(root: string) {
  for(let i=0;i<100;i++) { if ((await musicDescriptors(root)).length === 0) return; await delay(20); }
  assert.deepEqual(await musicDescriptors(root),[]);
}

test('real HTTP sends concurrent files and byte ranges independently', async () => {
  const f=await start(); try {
    const routes=f.tracks.map(t=>`/api/v1/tracks/${t.id}/stream`);
    const responses=await Promise.all([
      get(f.base,routes[0],{Range:'bytes=3-2047'}),
      get(f.base,routes[1],{Range:'bytes=4000-'}),
      get(f.base,routes[0],{Range:'bytes=-512'}),
    ]);
    const result=await Promise.all(responses.map(body));
    assert.deepEqual(responses.map(r=>r.statusCode),[206,206,206]);
    assert.deepEqual(result[0],f.a.subarray(3,2048)); assert.deepEqual(result[1],f.b.subarray(4000)); assert.deepEqual(result[2],f.a.subarray(-512));
    assert.equal(responses[0].headers['content-range'],`bytes 3-2047/${f.a.length}`);
    await assertNoDescriptors(f.root);
  } finally {await f.cleanup();}
});

test('client disconnect closes source and snapshot descriptors', async () => {
  const f=await start(); try {
    const response=await get(f.base,`/api/v1/tracks/${f.tracks[0].id}/stream`);
    assert.equal(response.statusCode,200);
    await new Promise<void>((resolve,reject)=>{response.once('data',()=>{response.destroy();resolve();});response.once('error',reject);});
    await assertNoDescriptors(f.root);
  } finally {await f.cleanup();}
});

test('in-place changes during playback do not mix old and new bytes', async () => {
  const f=await start(); try {
    const url=`/api/v1/tracks/${f.tracks[0].id}/stream`;
    const response=await get(f.base,url); const oldTag=response.headers.etag;
    assert.equal(response.statusCode,200);
    const data: Buffer[]=[];
    await new Promise<void>((resolve,reject)=>{
      response.once('data',chunk=>{
        response.pause(); data.push(Buffer.from(chunk));
        writeFile(path.join(f.root,'a.wav'),wav(0x55)).then(()=>resolve(),reject);
      }); response.once('error',reject);
    });
    const changed=await get(f.base,url,{Range:'bytes=0-100','If-Range':oldTag!}); assert.equal(changed.statusCode,409); await body(changed);
    await f.catalog.scan(f.storage);
    const next=await get(f.base,url,{Range:'bytes=0-100','If-Range':oldTag!});
    assert.equal(next.statusCode,200); assert.notEqual(next.headers.etag,oldTag); assert.deepEqual(await body(next),wav(0x55));
    response.resume(); data.push(await body(response)); assert.deepEqual(Buffer.concat(data),f.a);
    await assertNoDescriptors(f.root);
  } finally {await f.cleanup();}
});

test('atomic replacement during playback preserves the open representation', async () => {
  const f=await start(); try {
    const url=`/api/v1/tracks/${f.tracks[0].id}/stream`, response=await get(f.base,url);
    const chunks: Buffer[]=[];
    await new Promise<void>((resolve,reject)=>{ response.once('data',chunk=>{response.pause();chunks.push(Buffer.from(chunk));resolve();}); response.once('error',reject); });
    const replacement=path.join(f.root,'replacement.tmp'); await writeFile(replacement,wav(0x66)); await rename(replacement,path.join(f.root,'a.wav'));
    response.resume();chunks.push(await body(response));assert.deepEqual(Buffer.concat(chunks),f.a);
    const stale=await get(f.base,url);assert.equal(stale.statusCode,409);await body(stale);await assertNoDescriptors(f.root);
  } finally {await f.cleanup();}
});

test('mutation during snapshot returns 409 before sending bytes', async () => {
  const f=await start(); try {
    await f.app.close();
    let armed=true;
    const adapter: StorageAdapter={sourceId:f.storage.sourceId,list:()=>f.storage.list(),open:async key=>{
      const opened=await f.storage.open(key);
      return {...opened,stream:options=>{const s=opened.stream(options);if(armed){armed=false;s.once('data',()=>writeFileSync(path.join(f.root,'a.wav'),wav(0x77)));}return s;}};
    }};
    const app=buildApp(f.catalog,adapter,f.cache); const base=await app.listen({host:'127.0.0.1',port:0});
    try {
      const r=await get(base,`/api/v1/tracks/${f.tracks[0].id}/stream`);
      assert.equal(r.statusCode,409);assert.equal(JSON.parse((await body(r)).toString()).error.code,'TRACK_CHANGED');await assertNoDescriptors(f.root);
    } finally {await app.close();}
  } finally {await f.cleanup();}
});

test('empty library, corrupt audio and inaccessible root', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'music-empty-test-'));
  const root=path.join(dir,'music');await mkdir(root);
  const storage=await LocalStorage.create(root);const catalog=new Catalog(path.join(dir,'db.sqlite'));const cache=await VersionCache.open(path.join(dir,'cache'),1024*1024*1024);
  const app=buildApp(catalog,storage,cache);
  try {
    const base=await app.listen({host:'127.0.0.1',port:0});
    assert.deepEqual((await catalog.scan(storage)),{added:0,updated:0,unchanged:0,removed:0,failed:0});
    assert.deepEqual(JSON.parse((await body(await get(base,'/api/v1/tracks'))).toString()).items,[]);
    await writeFile(path.join(root,'corrupt.wav'),'this is not a wav');
    const scan=await catalog.scan(storage); assert.equal(scan.failed,1);assert.equal(scan.added,0);
    await assert.rejects(LocalStorage.create(path.join(dir,'does-not-exist')));
    await rename(root, path.join(dir,'moved'));
    await assert.rejects(catalog.scan(storage));
    assert.equal((catalog.db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as {n:number}).n,0);
    await assertNoDescriptors(root);
  } finally {await app.close();await cache.close();catalog.close();await rm(dir,{recursive:true,force:true});}
});

test('twenty concurrent listeners share one immutable cached version and report resource metrics', async () => {
  const f=await start(); try {
    const cacheRoot=path.join(f.dir,'cache'), url=`/api/v1/tracks/${f.tracks[0].id}/stream`;
    const rssBefore=process.memoryUsage().rss, fdBefore=(await readdir('/proc/self/fd')).length;
    let peakRss=rssBefore, peakFds=fdBefore;
    const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);peakFds=Math.max(peakFds,readdirSync('/proc/self/fd').length);},2);sampler.unref();
    const coldStart=performance.now(); const cold=await get(f.base,url,{Range:'bytes=0-1023'});
    const coldMs=performance.now()-coldStart; assert.equal(cold.statusCode,206);assert.deepEqual(await body(cold),f.a.subarray(0,1024));
    const filesBefore=(await readdir(cacheRoot)).filter(s=>s.endsWith('.bin'));assert.equal(filesBefore.length,1);
    const infoBefore=await import('node:fs/promises').then(m=>m.stat(path.join(cacheRoot,filesBefore[0])));
    const warmStart=performance.now(); const warm=await get(f.base,url,{Range:'bytes=256-1279'});
    const warmMs=performance.now()-warmStart;assert.deepEqual(await body(warm),f.a.subarray(256,1280));
    const results=await Promise.all(Array.from({length:20},(_,i)=>get(f.base,url,{Range:`bytes=${i*10}-${i*10+31}`})));
    const payloads=await Promise.all(results.map(body));
    results.forEach((r,i)=>{assert.equal(r.statusCode,206);assert.deepEqual(payloads[i],f.a.subarray(i*10,i*10+32));});
    const filesAfter=(await readdir(cacheRoot)).filter(s=>s.endsWith('.bin'));assert.deepEqual(filesAfter,filesBefore);
    const infoAfter=await import('node:fs/promises').then(m=>m.stat(path.join(cacheRoot,filesAfter[0])));
    assert.equal(infoBefore.ino,infoAfter.ino);assert.equal(infoBefore.mtimeMs,infoAfter.mtimeMs);assert.equal(infoAfter.size,f.a.length);
    await assertNoDescriptors(f.root);
    clearInterval(sampler);
    const rssAfter=process.memoryUsage().rss, fdAfter=(await readdir('/proc/self/fd')).length;
    assert.ok(peakRss-rssBefore < 128*1024*1024);
    console.log(`CACHE_METRICS cold_ttfb_ms=${coldMs.toFixed(2)} warm_ttfb_ms=${warmMs.toFixed(2)} cache_bytes=${infoAfter.size} rss_before=${rssBefore} rss_peak=${peakRss} rss_after=${rssAfter} fds_before=${fdBefore} fds_peak=${peakFds} fds_after=${fdAfter}`);
  } finally {await f.cleanup();}
});

test('twenty simultaneous cold requests prepare a single copy', async () => {
  const f=await start();try {
    const url=`/api/v1/tracks/${f.tracks[0].id}/stream`, cacheRoot=path.join(f.dir,'cache');
    let preparations=0; const originalOpen=f.storage.open.bind(f.storage);
    f.storage.open=async key=>{const file=await originalOpen(key);return {...file,stream:options=>{preparations++;return file.stream(options);}};};
    const responses=await Promise.all(Array.from({length:20},(_,i)=>get(f.base,url,{Range:`bytes=${i}-${i+127}`})));
    const data=await Promise.all(responses.map(body));
    responses.forEach((r,i)=>{assert.equal(r.statusCode,206);assert.deepEqual(data[i],f.a.subarray(i,i+128));});
    assert.equal(preparations,1);
    const again=await get(f.base,url,{Range:'bytes=0-31'});await body(again);assert.equal(preparations,1);
    const files=(await readdir(cacheRoot)).filter(s=>s.endsWith('.bin'));assert.equal(files.length,1);
    const parts=(await readdir(cacheRoot)).filter(s=>s.startsWith('.part-'));assert.deepEqual(parts,[]);
    await assertNoDescriptors(f.root);
  } finally {await f.cleanup();}
});

test('cache quota pins active readers, evicts only after release, and rejects oversize', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'music-cache-quota-'));const root=path.join(dir,'music');await mkdir(root);
  await writeFile(path.join(root,'a.wav'),wav(1,1024*1024));await writeFile(path.join(root,'b.wav'),wav(2,1024*1024));
  const storage=await LocalStorage.create(root),cache=await VersionCache.open(path.join(dir,'cache'),1024*1024+44);
  try {
    const first=await storage.open('a.wav'),second=await storage.open('b.wav');
    try {
      const held=await cache.acquire('local','a.wav',first);
      await assert.rejects(cache.acquire('local','b.wav',second),{code:'CACHE_FULL'});
      assert.equal((await readdir(path.join(dir,'cache'))).filter(s=>s.endsWith('.bin')).length,1);
      held.release();const other=await cache.acquire('local','b.wav',second);other.release();
      assert.equal((await readdir(path.join(dir,'cache'))).filter(s=>s.endsWith('.bin')).length,1);
      const oversized={...second,size:2*1024*1024}; await assert.rejects(cache.acquire('local','large.wav',oversized),{code:'CACHE_FULL'});
    } finally {await first.close();await second.close();}
  } finally {await cache.close();await rm(dir,{recursive:true,force:true});}
});

test('cache recovers published entries and removes partial files after SIGKILL', async () => {
  const {spawn}=await import('node:child_process');
  const dir=await mkdtemp(path.join(os.tmpdir(),'music-cache-crash-'));const root=path.join(dir,'music');await mkdir(root);await writeFile(path.join(root,'a.wav'),wav(3,1024*1024));
  const cacheRoot=path.join(dir,'cache');
  const child=spawn(process.execPath,[new URL('./cache-child.js',import.meta.url).pathname,root,cacheRoot],{stdio:['ignore','pipe','pipe']});
  try {
    await new Promise<void>((resolve,reject)=>{let out='';child.stdout.on('data',chunk=>{out+=chunk;if(out.includes('READY'))resolve();});child.once('error',reject);child.once('exit',code=>reject(new Error(`child exited early: ${code}`)));});
    const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;
    const cache=await VersionCache.open(cacheRoot,1024*1024*1024);
    try {
      const files=await readdir(cacheRoot);assert.equal(files.filter(s=>s.endsWith('.bin')).length,1);assert.ok(!files.some(s=>s.startsWith('.part-')));
      const storage=await LocalStorage.create(root),file=await storage.open('a.wav');
      try {const lease=await cache.acquire('local','a.wav',file);assert.equal(path.basename(lease.path),files.find(s=>s.endsWith('.bin')));lease.release();} finally {await file.close();}
    } finally {await cache.close();}
  } finally {if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});


test('HTTP returns a clear error when the cache cannot hold a track', async () => {
  const f=await start(1024);try {
    const r=await get(f.base,`/api/v1/tracks/${f.tracks[0].id}/stream`);
    assert.equal(r.statusCode,503);assert.equal(JSON.parse((await body(r)).toString()).error.code,'CACHE_FULL');
    assert.equal((await readdir(path.join(f.dir,'cache'))).filter(x=>x.endsWith('.bin')).length,0);
    await assertNoDescriptors(f.root);
  } finally {await f.cleanup();}
});
