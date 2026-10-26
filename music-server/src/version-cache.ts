import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, chmod, link, open, readFile, readdir, rename, rm, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { OpenedObject } from './storage.js';

export class CacheError extends Error {
  constructor(public code: 'CACHE_FULL' | 'TRACK_CHANGED', message: string) { super(message); }
}
type Entry = { key: string; file: string; size: number; digest: string; readers: number; lastUsed: number };
export type CacheLease = { path: string; size: number; etag: string; release(): void };
const SHA = /^[a-f0-9]{64}$/;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

// One process owns a cache directory. References are protected by the event loop;
// quota reservations and on-disk publication are serialized by exclusive().
export class VersionCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Entry>>();
  private waiters = new Map<string, number>();
  private reserved = 0;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private constructor(private root: string, readonly maxBytes: number, private lockPath: string) {}
  static async open(root: string, maxBytes: number): Promise<VersionCache> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid MUSIC_CACHE_MAX_BYTES');
    await mkdir(root, {recursive:true, mode:0o700}); await chmod(root,0o700);
    const lockPath=path.join(root,'.lock');
    const candidate=path.join(root,`.part-lock-${randomUUID()}`);
    const lock=await open(candidate,'wx',0o600);
    try { await lock.writeFile(String(process.pid)); await lock.sync(); } finally { await lock.close(); }
    try {
      for (let attempt=0; ; attempt++) {
        try { await link(candidate,lockPath); break; }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
          const raw=await readFile(lockPath,'utf8').catch(()=> ''); const pid=Number(raw);
          if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid cache lock; inspect and remove it manually');
          try { process.kill(pid,0); throw new Error('Cache directory is already in use'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          await unlink(lockPath);
        }
      }
    } finally { await unlink(candidate).catch(()=>{}); }
    const cache=new VersionCache(root,maxBytes,lockPath);
    try { await cache.recover(); return cache; }
    catch (error) { await unlink(lockPath).catch(()=>{}); throw error; }
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T> {
    const previous=this.chain; let unlock!:()=>void;
    this.chain=new Promise<void>(resolve=>{unlock=resolve;});
    await previous; try {return await fn();} finally {unlock();}
  }
  private async recover() {
    for (const name of await readdir(this.root)) {
      if (name === '.lock') continue;
      if (name.startsWith('.part-')) {await rm(path.join(this.root,name),{recursive:true,force:true});continue;}
      const match=/^([a-f0-9]{64})\.([a-f0-9]{64})\.(\d+)\.bin$/.exec(name);
      if (!match) continue;
      const file=path.join(this.root,name), info=await lstat(file); const size=Number(match[3]);
      if (!info.isFile() || !Number.isSafeInteger(size) || info.size!==size) {await rm(file,{force:true});continue;}
      const hash=createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
      if (hash.digest('hex')!==match[2]) {await rm(file,{force:true});continue;}
      const old=this.entries.get(match[1]);
      if (old) { await rm(file,{force:true});continue; }
      this.entries.set(match[1],{key:match[1],file,size,digest:match[2],readers:0,lastUsed:info.mtimeMs});
    }
    await this.exclusive(()=>this.evictToFit(0));
  }
  private used(): number {return [...this.entries.values()].reduce((n,e)=>n+e.size,0);}
  private async evictToFit(extra: number) {
    if (extra > this.maxBytes) throw new CacheError('CACHE_FULL','Track exceeds cache capacity');
    const candidates=[...this.entries.values()].filter(e=>e.readers===0 && !this.waiters.has(e.key)).sort((a,b)=>a.lastUsed-b.lastUsed);
    while (this.used()+this.reserved+extra>this.maxBytes && candidates.length) {
      const e=candidates.shift()!;
      // Recheck after asynchronous filesystem operations; an acquire may have pinned it.
      if (e.readers || this.waiters.has(e.key) || this.entries.get(e.key)!==e) continue;
      this.entries.delete(e.key); await rm(e.file,{force:true});
    }
    if (this.used()+this.reserved+extra>this.maxBytes) throw new CacheError('CACHE_FULL','Cache has insufficient free capacity');
  }
  async acquire(sourceId:string, key:string, file:OpenedObject):Promise<CacheLease> {
    if (this.closed) throw new Error('Cache closed');
    const id=digest(JSON.stringify([sourceId,key,file.fingerprint,file.size]));
    this.waiters.set(id,(this.waiters.get(id)||0)+1);
    try {
      let entry=this.entries.get(id);
      if (!entry) {
        let task=this.pending.get(id);
        if (!task) {
          task=this.prepare(id,file); this.pending.set(id,task);
          void task.finally(()=>this.pending.delete(id)).catch(()=>{});
        }
        entry=await task;
      }
      // No await between finding and pinning; waiters protect it from eviction.
      entry.readers++;entry.lastUsed=Date.now();
      let released=false;
      return {path:entry.file,size:entry.size,etag:`"${entry.digest}"`,release:()=>{
        if (!released) {released=true;entry!.readers--;entry!.lastUsed=Date.now();}
      }};
    } finally {
      const n=this.waiters.get(id)!-1; if(n) this.waiters.set(id,n); else this.waiters.delete(id);
    }
  }
  private async prepare(id:string, file:OpenedObject):Promise<Entry> {
    await this.exclusive(async()=>{await this.evictToFit(file.size);this.reserved+=file.size;});
    const temp=path.join(this.root,`.part-${randomUUID()}`);
    let reserved=true;
    try {
      const hash=createHash('sha256');let written=0;
      const counter=new Transform({transform(chunk:Buffer,_encoding,callback){
        written+=chunk.length;
        if (written>file.size) return callback(new CacheError('TRACK_CHANGED','Track changed during preparation'));
        hash.update(chunk);callback(null,chunk);
      }});
      await pipeline(file.stream({autoClose:false}),counter,createWriteStream(temp,{flags:'wx',mode:0o600}));
      if (written!==file.size || !await file.unchanged()) throw new CacheError('TRACK_CHANGED','Track changed during preparation');
      const contentHash=hash.digest('hex');
      if (!SHA.test(contentHash)) throw new Error('Invalid digest');
      const target=path.join(this.root,`${id}.${contentHash}.${file.size}.bin`);
      // Atomic rename only after the complete file is closed and source verified.
      const output=await open(temp,'r');try{await output.sync();}finally{await output.close();}
      return await this.exclusive(async()=>{
        await chmod(temp,0o400);
        await rename(temp,target);
        const entry:Entry={key:id,file:target,size:file.size,digest:contentHash,readers:0,lastUsed:Date.now()};
        this.entries.set(id,entry);this.reserved-=file.size;reserved=false;return entry;
      });
    } catch (error) {
      if (['ENOSPC','EDQUOT'].includes((error as NodeJS.ErrnoException).code||'')) throw new CacheError('CACHE_FULL','Insufficient disk space for cache');
      throw error;
    } finally {
      await rm(temp,{force:true});
      if(reserved) await this.exclusive(async()=>{this.reserved-=file.size;});
    }
  }
  async close() {
    if (this.closed) return;this.closed=true;
    await Promise.allSettled([...this.pending.values()]);await this.chain;
    await unlink(this.lockPath).catch(()=>{});
  }
}
