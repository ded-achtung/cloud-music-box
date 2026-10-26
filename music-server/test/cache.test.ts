import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VersionCache } from '../src/version-cache.js';
import { LocalStorage } from '../src/storage.js';

// VersionCache is not used for local files; it is kept for future sources without random access.
function wav(fill: number, bytes: number): Buffer {
  const b = Buffer.alloc(44 + bytes, fill);
  b.write('RIFF',0); b.writeUInt32LE(b.length - 8,4); b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24); b.writeUInt32LE(16000,28); b.writeUInt16LE(2,32);
  b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(bytes,40);
  return b;
}

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
