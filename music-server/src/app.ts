import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { Catalog, trackDTO, type TrackRow } from './catalog.js';
import type { StorageAdapter } from './storage.js';

class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const bad = (message: string) => new ApiError(400, 'INVALID_REQUEST', message);
function page(query: unknown) {
  const q = query as Record<string, unknown>;
  const parse = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw bad('Invalid pagination');
    const n = Number(value); if (!Number.isSafeInteger(n)) throw bad('Invalid pagination'); return n;
  };
  const limit = parse(q.limit, 50), offset = parse(q.offset, 0);
  if (limit < 1 || limit > 100) throw bad('limit must be between 1 and 100');
  return {limit, offset};
}
type ByteRange = { start: number; end: number } | 'ignore' | 'unsatisfiable';
export function parseRange(header: string, size: number): ByteRange {
  if (!header.startsWith('bytes=') || header.includes(',')) return 'ignore';
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return 'ignore';
  const a = m[1] ? Number(m[1]) : undefined, b = m[2] ? Number(m[2]) : undefined;
  if ((a !== undefined && !Number.isSafeInteger(a)) || (b !== undefined && !Number.isSafeInteger(b))) return 'ignore';
  if (size === 0 || (a === undefined && b === 0) || (a !== undefined && (a >= size || (b !== undefined && b < a)))) return 'unsatisfiable';
  return a === undefined ? { start: Math.max(0, size - b!), end: size - 1 } : { start: a, end: Math.min(b ?? size - 1, size - 1) };
}
export function buildApp(catalog: Catalog, storage: StorageAdapter) {
  const app = Fastify({ logger: false, exposeHeadRoutes: false });
  app.setErrorHandler((err, _req, reply) => {
    const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL_ERROR', 'Internal server error');
    if (e.status === 500) app.log.error(err);
    reply.removeHeader('Content-Range').removeHeader('Content-Length').type('application/json');
    void reply.code(e.status).send({ error: { code: e.code, message: e.message } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }));
  app.get('/api/v1/server-info', async () => ({ name: 'cloud-music-server', version: '0.1.0', api: { major: 1, minor: 0, basePath: '/api/v1' }, capabilities: { range: true, localStorage: true, artwork: true, apkUpdates: false }, authentication: 'none' }));
  app.get('/api/v1/tracks', async req => {
    const {limit, offset} = page(req.query);
    const rows = catalog.db.prepare('SELECT * FROM tracks ORDER BY title COLLATE NOCASE,id LIMIT ? OFFSET ?').all(limit + 1, offset) as unknown as TrackRow[];
    return { items: rows.slice(0, limit).map(trackDTO), pagination: { limit, offset, nextOffset: rows.length > limit ? offset + limit : null } };
  });
  app.get('/api/v1/tracks/:id', async req => {
    const t = catalog.get((req.params as {id:string}).id); if (!t) throw new ApiError(404, 'TRACK_NOT_FOUND', 'Track not found'); return trackDTO(t);
  });
  app.get('/api/v1/albums', async req => {
    const {limit,offset} = page(req.query);
    const rows = catalog.db.prepare(`SELECT album_id AS id, album AS title, album_artist AS artist, COUNT(*) AS trackCount,
      MIN(artwork_hash) AS artworkHash FROM tracks GROUP BY album_id ORDER BY title COLLATE NOCASE,id LIMIT ? OFFSET ?`).all(limit + 1,offset) as unknown as {id:string;title:string;artist:string;trackCount:number;artworkHash:string|null}[];
    return {items: rows.slice(0,limit).map(({artworkHash,...r}) => ({...r,artworkUrl: artworkHash ? `/api/v1/artworks/${artworkHash}` : null})), pagination:{limit,offset,nextOffset:rows.length > limit ? offset+limit : null}};
  });
  app.get('/api/v1/artworks/:hash', async (req, reply) => {
    const key = (req.params as {hash:string}).hash;
    if (!/^[a-f0-9]{64}$/.test(key)) throw new ApiError(404,'NOT_FOUND','Artwork not found');
    const row = catalog.db.prepare('SELECT mime_type,data FROM artworks WHERE hash=?').get(key) as unknown as {mime_type:string;data:Uint8Array}|undefined;
    if (!row) throw new ApiError(404,'NOT_FOUND','Artwork not found');
    return reply.type(row.mime_type).header('ETag', `"${key}"`).send(Buffer.from(row.data));
  });
  // Reserved without exposing an administrative surface or implying an updater exists.
  app.get('/updates/android/stable/manifest.json', async () => { throw new ApiError(501,'NOT_IMPLEMENTED','Android updates are not available'); });
  const stream = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const t = catalog.get((req.params as {id:string}).id);
    if (!t || t.source_id !== storage.sourceId) throw new ApiError(404,'TRACK_NOT_FOUND','Track not found');
    let file;
    try { file = await storage.open(t.relative_path); }
    catch { throw new ApiError(404,'TRACK_UNAVAILABLE','Track is unavailable'); }
    try {
      const { size, fingerprint } = file;
      if (fingerprint !== t.fingerprint) throw new ApiError(409,'TRACK_CHANGED','Track changed; rescan library');
      const etag = `"${createHash('sha256').update(fingerprint).digest('hex')}"`;
      reply.header('Accept-Ranges','bytes').header('ETag',etag).type(t.mime_type);
      const range = req.method === 'GET' && req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)
        ? parseRange(req.headers.range,size) : 'ignore';
      if (range === 'unsatisfiable') {
        await file.close();
        return reply.code(416).type('application/json').header('Content-Range',`bytes */${size}`).send({error:{code:'RANGE_NOT_SATISFIABLE',message:'Range not satisfiable'}});
      }
      if (req.method === 'HEAD' || size === 0) {
        await file.close();
        return reply.header('Content-Length',size).send();
      }
      // Copy to a private disk snapshot before sending headers. An open file
      // descriptor alone does not prevent in-place writes to the source inode.
      const abort = new AbortController();
      const cancel = () => abort.abort();
      reply.raw.once('close', cancel);
      let dir: string | undefined;
      let snapshot: Awaited<ReturnType<typeof open>> | undefined;
      try {
        dir = await mkdtemp(path.join(os.tmpdir(),'music-server-stream-'));
        const snapshotPath = path.join(dir,'audio');
        await pipeline(file.stream({ autoClose: false }),
          createWriteStream(snapshotPath, { flags: 'wx', mode: 0o600 }), { signal: abort.signal });
        if (!await file.unchanged()) throw new ApiError(409,'TRACK_CHANGED','Track changed; rescan library');
        snapshot = await open(snapshotPath,'r');
        if ((await snapshot.stat()).size !== size) throw new ApiError(409,'TRACK_CHANGED','Track changed; rescan library');
        await unlink(snapshotPath); // FD owns the snapshot, including on client disconnect.
        await rm(dir, {recursive:true,force:true}); dir = undefined;
        await file.close();
        if (abort.signal.aborted) throw new Error('Client disconnected');
        if (range !== 'ignore') {
          reply.code(206).header('Content-Range',`bytes ${range.start}-${range.end}/${size}`).header('Content-Length', range.end-range.start+1);
        } else reply.header('Content-Length',size);
        const body = snapshot.createReadStream({start:range === 'ignore' ? 0 : range.start, end:range === 'ignore' ? size-1 : range.end, autoClose:true});
        snapshot = undefined;
        reply.raw.once('close', () => body.destroy());
        return reply.send(body);
      } finally {
        reply.raw.removeListener('close', cancel);
        await snapshot?.close().catch(() => {});
        if (dir) await rm(dir,{recursive:true,force:true});
      }
    } catch (error) { await file.close().catch(() => {}); throw error; }
  };
  app.route({ method: ['GET','HEAD'], url: '/api/v1/tracks/:id/stream', handler: stream });
  return app;
}
