CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  artists_json TEXT NOT NULL,
  album_id TEXT NOT NULL,
  album TEXT NOT NULL,
  album_artist TEXT NOT NULL,
  duration REAL,
  format TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  artwork_hash TEXT,
  UNIQUE(source_id, relative_path)
);
CREATE TABLE IF NOT EXISTS artworks (
  hash TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS tracks_title ON tracks(title COLLATE NOCASE, id);
