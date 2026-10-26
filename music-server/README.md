# Music Server v0.1.0 — local library

Ubuntu service for a shared catalogue and independent HTTP audio streams. Node.js 24 LTS, Fastify 5, and Node's `node:sqlite` (release-candidate API). The service has no user authentication; keep it on localhost or a trusted private network until authentication is implemented. No client playback state is shared.

## Requirements and setup

- Ubuntu/Linux with `/proc` mounted (opened file descriptors are verified using `/proc/self/fd`).
- Node.js 24 LTS and npm; a user who can read the music folder.
- At least a few MB free for the SQLite catalogue and embedded album art.

```sh
cd music-server
npm ci
npm run build
MUSIC_ROOT="$HOME/Music" npm start
```

The server scans on startup. To update the catalogue while running, stop the server and start it again, or use a separate scan and restart (`MUSIC_ROOT="$HOME/Music" npm run scan`). Store its database outside the music directory, using `MUSIC_DB=/absolute/path/catalog.sqlite`. The default is `./data/catalog.sqlite`; SQLite migrations run automatically. Changing the configured root creates a new local library, so use a separate DB for each root. ID stability applies to an unchanged path in the same database; renames create a new ID.

By default the server listens only on `127.0.0.1:3000`. Explicitly set `HOST=0.0.0.0` to make it reachable on the local network, and `PORT=3000` to choose a port. Firewall and transport protection are the operator's responsibility. No network configuration is changed by this repository. Do not put personal music, DB files, or credentials into git.

The scan ignores symlinks and only reads regular files inside the configured root. WAV, MP3, FLAC, M4A, OGG and AAC are indexed when their metadata can be parsed. Bad files are reported in the scan summary. Albums are grouped by album title and album artist, not only by title. Existing entries retain their ID after metadata or content changes at the same path. Deleted files disappear after a successful scan. Files changed after scanning return `409 TRACK_CHANGED` until rescanned.

## API v1

```sh
curl http://127.0.0.1:3000/api/v1/server-info
curl 'http://127.0.0.1:3000/api/v1/tracks?limit=20&offset=0'
curl 'http://127.0.0.1:3000/api/v1/albums?limit=20&offset=0'
curl http://127.0.0.1:3000/api/v1/tracks/TRACK_ID
curl -I http://127.0.0.1:3000/api/v1/tracks/TRACK_ID/stream
curl -H 'Range: bytes=0-1023' http://127.0.0.1:3000/api/v1/tracks/TRACK_ID/stream -o part.bin
curl -H 'Range: bytes=-256' http://127.0.0.1:3000/api/v1/tracks/TRACK_ID/stream -o tail.bin
curl -H 'Range: bytes=1024-' -H 'If-Range: "ETAG_FROM_HEAD"' http://127.0.0.1:3000/api/v1/tracks/TRACK_ID/stream -o rest.bin
```

`server-info` publishes the API major/minor and capabilities. List responses contain `items` and `pagination` (`limit`, `offset`, `nextOffset`). Limit is 1–100. Offset pagination can move if a scan changes the catalogue between requests. Errors are `{ "error": { "code": "...", "message": "..." } }`. The update manifest route is reserved and returns 501.

Single byte ranges use 206, unsatisfiable ranges use 416, and unrecognized/multiple range headers are ignored with 200. HEAD returns the full representation's headers. Matching strong `If-Range` ETags permit a partial response; all other If-Range values fall back to the full representation. The first request for a source version creates a private, immutable disk cache entry. Concurrent requests share the preparation; later requests stream only the requested range from it. The source version is checked after copying and content is hashed before atomic publication. A source changed during preparation returns 409; already active readers keep the old version. ETag is the cached content SHA-256. HEAD also prepares a cold file so it can return the same strong ETag as GET. Neither preparation nor streaming loads a full audio file into RAM.

Configure `MUSIC_CACHE_DIR` (default: `audio-cache` next to the database) and `MUSIC_CACHE_MAX_BYTES` (default: 1073741824). Only one server process may use a cache directory. The cache reserves capacity before writing, shares work for identical versions, and evicts least recently used entries without active or waiting readers. When a track is larger than the limit, all space is pinned, or the filesystem reports ENOSPC/EDQUOT, the API returns HTTP 503 with `CACHE_FULL`. Old readers are never evicted to make room for a new version. Allow disk space for the configured limit and other services. On restart the server removes incomplete `.part-*` files, validates completed files by SHA-256 and recovers valid versions. A stale PID lock after a crash is recovered when the process no longer exists; a malformed lock or PID reused by another process requires operator inspection. Cache directory access is restricted to the server user. Sources have an independent `StorageAdapter` contract; cloud providers are not implemented.

## Tests

```sh
npm test
```

Tests generate WAV fixtures and use temporary SQLite databases. They exercise Fastify injection and real HTTP requests to an ephemeral localhost port, including 20 concurrent cold requests and SIGKILL recovery. The HTTP suite prints CACHE_METRICS with cold and warm time to headers (TTFB), cache bytes, RSS and process descriptor counts; results depend on CPU, filesystem and runner load. They exercise rescans, seek ranges, concurrent requests, errors, traversal and symlink escapes. A real Android client, physical network, reverse proxy, cloud sources, authentication and updater are outside this stage.
