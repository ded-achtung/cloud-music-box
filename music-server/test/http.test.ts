import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, rename, readdir, readlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Catalog } from '../src/catalog.js';
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
async function start() {
  const dir=await mkdtemp(path.join(os.tmpdir(),'music-http-test-'));
  const root=path.join(dir,'music'); await mkdir(root);
  const a=wav(0x2a), b=wav(0x7b);
  await writeFile(path.join(root,'a.wav'),a); await writeFile(path.join(root,'b.wav'),b);
  const storage=await LocalStorage.create(root), catalog=new Catalog(path.join(dir,'catalog.sqlite'));
  await catalog.scan(storage);
  const app=buildApp(catalog,storage); const base=await app.listen({host:'127.0.0.1',port:0});
  const tracks=catalog.db.prepare('SELECT id,name FROM tracks ORDER BY name').all() as unknown as {id:string;name:string}[];
  return {dir,root,a,b,storage,catalog,app,base,tracks,cleanup:async()=>{await app.close();catalog.close();await rm(dir,{recursive:true,force:true});}};
}
function get(base: string, route: string, headers: Record<string,string> = {}): Promise<IncomingMessage> {
  return new Promise((resolve,reject)=>{const req=request(new URL(route,base),{headers,agent:false},resolve);req.on('error',reject);req.end();});
}
async function body(res: IncomingMessage): Promise<Buffer> { const parts: Buffer[]=[]; for await (const c of res) parts.push(Buffer.from(c)); return Buffer.concat(parts); }
async function musicDescriptors(root: string): Promise<string[]> {
  const names=await readdir('/proc/self/fd');
  const targets=await Promise.all(names.map(async n=>readlink(`/proc/self/fd/${n}`).catch(()=>'')));
  return targets.filter(s=>s.startsWith(root + '/') || s.includes('music-server-stream-'));
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
    response.resume(); data.push(await body(response)); assert.deepEqual(Buffer.concat(data),f.a);
    const changed=await get(f.base,url,{Range:'bytes=0-100','If-Range':oldTag!}); assert.equal(changed.statusCode,409); await body(changed);
    await f.catalog.scan(f.storage);
    const next=await get(f.base,url,{Range:'bytes=0-100','If-Range':oldTag!});
    assert.equal(next.statusCode,200); assert.notEqual(next.headers.etag,oldTag); assert.deepEqual(await body(next),wav(0x55));
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
    const app=buildApp(f.catalog,adapter); const base=await app.listen({host:'127.0.0.1',port:0});
    try {
      const r=await get(base,`/api/v1/tracks/${f.tracks[0].id}/stream`);
      assert.equal(r.statusCode,409);assert.equal(JSON.parse((await body(r)).toString()).error.code,'TRACK_CHANGED');await assertNoDescriptors(f.root);
    } finally {await app.close();}
  } finally {await f.cleanup();}
});

test('empty library, corrupt audio and inaccessible root', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'music-empty-test-'));
  const root=path.join(dir,'music');await mkdir(root);
  const storage=await LocalStorage.create(root);const catalog=new Catalog(path.join(dir,'db.sqlite'));const app=buildApp(catalog,storage);
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
  } finally {await app.close();catalog.close();await rm(dir,{recursive:true,force:true});}
});
