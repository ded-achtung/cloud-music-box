import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Catalog } from '../src/catalog.js';
import { VersionCache } from '../src/version-cache.js';
import { LocalStorage } from '../src/storage.js';
import { buildApp, parseRange } from '../src/app.js';

// Programmatically generated mono PCM WAV; no third-party audio is required.
function wav(samples = 8000): Buffer {
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF',0); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
  data.writeUInt32LE(8000,24); data.writeUInt32LE(16000,28); data.writeUInt16LE(2,32);
  data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) data.writeInt16LE((i%256-128)*100,44+i*2);
  return data;
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(),'music-server-'));
  const music = path.join(dir,'music'); await mkdir(music);
  const first = wav(), second = wav(6000);
  await writeFile(path.join(music,'a.wav'),first); await writeFile(path.join(music,'b.wav'),second);
  const storage = await LocalStorage.create(music), catalog = new Catalog(path.join(dir,'test.sqlite'));
  const cache=await VersionCache.open(path.join(dir,'cache'),1024*1024*1024);
  const app = buildApp(catalog,storage,cache);
  return {dir,music,first,second,storage,catalog,app,cleanup:async()=>{await app.close(); await cache.close(); catalog.close(); await rm(dir,{recursive:true,force:true});}};
}

test('index, rescan, update and deletion preserve stable IDs', async () => {
  const f=await fixture(); try {
    const first=await f.catalog.scan(f.storage); assert.deepEqual(first,{added:2,updated:0,unchanged:0,removed:0,failed:0});
    const a=(f.catalog.db.prepare('SELECT * FROM tracks ORDER BY name').all() as unknown as {id:string;duration:number}[]);
    assert.equal(a.length,2); assert.equal(a[0].duration,1);
    assert.equal((await f.catalog.scan(f.storage)).unchanged,2);
    await writeFile(path.join(f.music,'a.wav'),wav(4000));
    assert.equal((await f.catalog.scan(f.storage)).updated,1);
    const id=(f.catalog.db.prepare("SELECT id FROM tracks WHERE name='a.wav'").get() as {id:string}).id;
    assert.equal(id,a[0].id);
    await rm(path.join(f.music,'b.wav')); assert.equal((await f.catalog.scan(f.storage)).removed,1);
  } finally {await f.cleanup();}
});

test('range, if-range, HEAD, errors, pagination and independent requests', async () => {
  const f=await fixture(); try {
    await f.catalog.scan(f.storage);
    const list=await f.app.inject({url:'/api/v1/tracks?limit=1'}); assert.equal(list.statusCode,200);
    const p=list.json(); assert.equal(p.items.length,1); assert.equal(p.pagination.nextOffset,1);
    const secondPage=(await f.app.inject({url:'/api/v1/tracks?limit=1&offset=1'})).json();
    const secondId=secondPage.items[0].id as string;
    const id=p.items[0].id as string, url=`/api/v1/tracks/${id}/stream`;
    const full=await f.app.inject({url}); assert.equal(full.statusCode,200); assert.deepEqual(full.rawPayload,f.first);
    const etag=full.headers.etag; assert.ok(etag); assert.equal(full.headers['accept-ranges'],'bytes');
    for (const [header,start,end] of [['bytes=5-9',5,9],['bytes=10-',10,f.first.length-1],['bytes=-7',f.first.length-7,f.first.length-1]] as const) {
      const r=await f.app.inject({url,headers:{range:header}}); assert.equal(r.statusCode,206); assert.equal(r.headers['content-range'],`bytes ${start}-${end}/${f.first.length}`); assert.deepEqual(r.rawPayload,f.first.subarray(start,end+1));
      assert.equal(Number(r.headers['content-length']),end-start+1);
    }
    const invalid=await f.app.inject({url,headers:{range:'bytes=999999-'}}); assert.equal(invalid.statusCode,416); assert.equal(invalid.headers['content-range'],`bytes */${f.first.length}`);
    const stale=await f.app.inject({url,headers:{range:'bytes=0-3','if-range':'"old"'}}); assert.equal(stale.statusCode,200); assert.deepEqual(stale.rawPayload,f.first);
    const valid=await f.app.inject({url,headers:{range:'bytes=0-3','if-range':etag!}}); assert.equal(valid.statusCode,206);
    const head=await f.app.inject({method:'HEAD',url,headers:{range:'bytes=0-3'}}); assert.equal(head.statusCode,200); assert.equal(Number(head.headers['content-length']),f.first.length); assert.equal(head.rawPayload.length,0);
    const parallel=await Promise.all(Array.from({length:20},(_,i)=>f.app.inject({url,headers:{range:`bytes=${i}-${i+9}`}})));
    parallel.forEach((r,i)=>{assert.equal(r.statusCode,206);assert.deepEqual(r.rawPayload,f.first.subarray(i,i+10));});
    const different=await Promise.all([f.app.inject({url,headers:{range:'bytes=0-9'}}),f.app.inject({url:`/api/v1/tracks/${secondId}/stream`,headers:{range:'bytes=20-29'}})]);
    assert.deepEqual(different[0].rawPayload,f.first.subarray(0,10)); assert.deepEqual(different[1].rawPayload,f.second.subarray(20,30));
    assert.equal((await f.app.inject({url:'/api/v1/tracks/missing'})).json().error.code,'TRACK_NOT_FOUND');
    assert.equal((await f.app.inject({url:'/api/v1/tracks?limit=0'})).json().error.code,'INVALID_REQUEST');
    assert.equal((await f.app.inject({url:'/updates/android/stable/manifest.json'})).statusCode,501);
    assert.equal((await f.app.inject({url:'/no-route'})).json().error.code,'NOT_FOUND');
  } finally {await f.cleanup();}
});

test('symlinks, traversal, and replaced directories cannot escape root', async () => {
  const f=await fixture(); try {
    const outside=path.join(f.dir,'secret.wav'); await writeFile(outside,wav()); await writeFile(path.join(f.dir,'song.wav'),wav());
    await symlink(outside,path.join(f.music,'escape.wav'));
    await symlink(f.dir,path.join(f.music,'external'));
    await mkdir(path.join(f.music,'inside')); await writeFile(path.join(f.music,'inside','song.wav'),wav());
    await f.catalog.scan(f.storage);
    const items=(await f.app.inject({url:'/api/v1/tracks'})).json().items as {id:string;name:string}[];
    assert.equal(items.length,3); assert.ok(!items.some(t=>t.name==='escape.wav'));
    await assert.rejects(f.storage.open('../secret.wav')); await assert.rejects(f.storage.open('escape.wav')); await assert.rejects(f.storage.open('external/secret.wav'));
    const song=items.find(t=>t.name==='song.wav')!;
    await rename(path.join(f.music,'inside'),path.join(f.music,'old'));
    await symlink(f.dir,path.join(f.music,'inside'));
    const response=await f.app.inject({url:`/api/v1/tracks/${song.id}/stream`}); assert.equal(response.statusCode,404);
  } finally {await f.cleanup();}
});

test('range parser handles invalid and empty ranges', () => {
  assert.equal(parseRange('bytes=0-0',0),'unsatisfiable');
  assert.equal(parseRange('bytes=-0',20),'unsatisfiable');
  assert.equal(parseRange('bytes=10-3',20),'unsatisfiable');
  assert.equal(parseRange('bytes=1-2,4-5',20),'ignore');
  assert.equal(parseRange('nonsense',20),'ignore');
});
