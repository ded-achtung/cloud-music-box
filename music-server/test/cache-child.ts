import { readdir, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { VersionCache } from '../src/version-cache.js';
import { LocalStorage } from '../src/storage.js';
const [root, cacheRoot] = process.argv.slice(2);
const cache=await VersionCache.open(cacheRoot,1024*1024*1024);
const storage=await LocalStorage.create(root), file=await storage.open('a.wav');
const lease=await cache.acquire(storage.sourceId,'a.wav',file);lease.release();await file.close();
const unfinished=await storage.open('a.wav');
const slow={...unfinished,stream:(options?:{start?:number;end?:number;autoClose?:boolean})=>
  unfinished.stream(options).pipe(new Transform({transform(chunk,_encoding,callback){setTimeout(()=>callback(null,chunk),30);}}))};
void cache.acquire(storage.sourceId,'unfinished',slow);
const timer=setInterval(async()=>{
  const part=(await readdir(cacheRoot)).find(name=>name.startsWith('.part-'));
  if(part && (await stat(path.join(cacheRoot,part)).catch(()=>({size:0}))).size>0) {
    clearInterval(timer);process.stdout.write('READY\n');
  }
},5);
