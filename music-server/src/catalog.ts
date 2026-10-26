import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseStream } from 'music-metadata';
import { formats, type StorageAdapter } from './storage.js';

export interface TrackRow {
  id: string; source_id: string; relative_path: string; fingerprint: string;
  name: string; title: string; artists_json: string; album_id: string; album: string;
  album_artist: string; duration: number | null; format: string; mime_type: string;
  size: number; artwork_hash: string | null;
}
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export class Catalog {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    const applied = this.db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get();
    if (!applied) {
      const sql = readFileSync(new URL('../../migrations/001_initial.sql', import.meta.url), 'utf8');
      this.db.exec('BEGIN');
      try { this.db.exec(sql); this.db.prepare('INSERT INTO schema_migrations VALUES (1)').run(); this.db.exec('COMMIT'); }
      catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  close() { this.db.close(); }
  get(id: string): TrackRow | undefined { return this.db.prepare('SELECT * FROM tracks WHERE id=?').get(id) as unknown as TrackRow | undefined; }
  async scan(storage: StorageAdapter): Promise<{ added: number; updated: number; unchanged: number; removed: number; failed: number }> {
    const result = { added: 0, updated: 0, unchanged: 0, removed: 0, failed: 0 };
    const seen = new Set<string>();
    for await (const entry of storage.list()) {
      seen.add(entry.key);
      const old = this.db.prepare('SELECT * FROM tracks WHERE source_id=? AND relative_path=?').get(storage.sourceId, entry.key) as unknown as TrackRow | undefined;
      if (old?.fingerprint === entry.fingerprint) { result.unchanged++; continue; }
      let handle;
      try {
        handle = await storage.open(entry.key);
        const current = handle.fingerprint;
        if (current !== entry.fingerprint) throw new Error('File changed during scan');
        const stream = handle.stream({ autoClose: false });
        const metadata = await parseStream(stream, { mimeType: formats[path.extname(entry.key).toLowerCase()], size: handle.size }, { duration: true });
        stream.destroy();
        if (!await handle.unchanged()) throw new Error('File changed during scan');
        const name = path.basename(entry.key);
        const title = metadata.common.title || name;
        const artists = metadata.common.artists?.length ? metadata.common.artists : metadata.common.artist ? [metadata.common.artist] : [];
        const album = metadata.common.album || 'Unknown Album';
        const albumArtist = metadata.common.albumartist || artists.join(', ') || 'Unknown Artist';
        const albumId = hash(JSON.stringify([album, albumArtist]));
        const picture = metadata.common.picture?.[0];
        let artwork: string | null = null;
        if (picture && picture.data.length <= 5 * 1024 * 1024 && /^image\/(jpeg|png|webp|gif)$/.test(picture.format)) {
          artwork = hash(picture.data);
          this.db.prepare('INSERT OR IGNORE INTO artworks(hash,mime_type,data) VALUES (?,?,?)').run(artwork, picture.format, picture.data);
        }
        this.db.prepare(`INSERT INTO tracks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(source_id,relative_path) DO UPDATE SET fingerprint=excluded.fingerprint,name=excluded.name,title=excluded.title,
          artists_json=excluded.artists_json,album_id=excluded.album_id,album=excluded.album,album_artist=excluded.album_artist,
          duration=excluded.duration,format=excluded.format,mime_type=excluded.mime_type,size=excluded.size,artwork_hash=excluded.artwork_hash`).run(
          old?.id || randomUUID(), storage.sourceId, entry.key, current, name, title, JSON.stringify(artists), albumId, album,
          albumArtist, Number.isFinite(metadata.format.duration) ? metadata.format.duration! : null,
          path.extname(entry.key).slice(1).toLowerCase(), formats[path.extname(entry.key).toLowerCase()], handle.size, artwork);
        old ? result.updated++ : result.added++;
      } catch (error) { result.failed++; console.error(`Cannot index ${entry.key}:`, error); }
      finally { await handle?.close(); }
    }
    // Deletion only after a complete directory traversal; a failed traversal throws.
    const rows = this.db.prepare('SELECT id,relative_path FROM tracks WHERE source_id=?').all(storage.sourceId) as unknown as {id:string;relative_path:string}[];
    for (const row of rows) if (!seen.has(row.relative_path)) { this.db.prepare('DELETE FROM tracks WHERE id=?').run(row.id); result.removed++; }
    this.db.exec('DELETE FROM artworks WHERE hash NOT IN (SELECT artwork_hash FROM tracks WHERE artwork_hash IS NOT NULL)');
    return result;
  }
}
export function trackDTO(t: TrackRow) {
  return { id: t.id, title: t.title, name: t.name, artists: JSON.parse(t.artists_json) as string[],
    album: { id: t.album_id, title: t.album, artist: t.album_artist }, durationSeconds: t.duration,
    format: t.format, mimeType: t.mime_type, size: t.size,
    artworkUrl: t.artwork_hash ? `/api/v1/artworks/${t.artwork_hash}` : null };
}
