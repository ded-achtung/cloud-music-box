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

The server starts answering at once with the catalogue it already has and scans the library in the background. While it runs it keeps the catalogue up to date without a restart:

- a file watcher on `MUSIC_ROOT` rescans 3 seconds after the folder goes quiet, so a long copy is scanned once it finishes (`MUSIC_WATCH=0` disables the watcher);
- a periodic scan catches anything the watcher missed, every `MUSIC_SCAN_INTERVAL_SECONDS` (default 900; `0` disables it);
- `kill -HUP <pid>` (or `systemctl kill -s HUP <unit>`) requests a scan by hand.

Only one scan runs at a time; requests during a scan are merged into one follow-up scan. A failed scan (for example, an unmounted music folder) is logged, removes no tracks and is retried on the next trigger. Tracks appear as they are indexed; files that are still being copied may be indexed with partial metadata and are corrected by the scan that follows the copy. `npm run scan` scans once and exits; it is meant for when the server is stopped. Store its database outside the music directory, using `MUSIC_DB=/absolute/path/catalog.sqlite`. The default is `./data/catalog.sqlite`; SQLite migrations run automatically. Changing the configured root creates a new local library, so use a separate DB for each root. ID stability applies to an unchanged path in the same database; renames create a new ID.

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

`server-info` publishes the API major/minor and capabilities. Since API 1.1 it also reports `library`: `scanning`, `lastScanAt`, `lastScanOk` and an opaque `revision` that changes whenever a scan may have changed the catalogue; clients compare it for equality to know when to reload the track list. List responses contain `items` and `pagination` (`limit`, `offset`, `nextOffset`). Limit is 1–100. Offset pagination can move if a scan changes the catalogue between requests. Errors are `{ "error": { "code": "...", "message": "..." } }`. The update manifest route is reserved and returns 501.

Single byte ranges use 206, unsatisfiable ranges use 416, and unrecognized/multiple range headers are ignored with 200. HEAD returns the full representation's headers. Matching strong `If-Range` ETags permit a partial response; all other If-Range values fall back to the full representation.

Local tracks are streamed directly from the opened file: the first byte does not wait for the whole track, seeking is a plain byte range, and many phones can listen to different tracks at the same time without extra disk space. Each request opens its own descriptor, so no playback state is shared between clients. The ETag is derived from the file identity, size and timestamps recorded at scan time; it changes whenever the file is rewritten.

A file replaced atomically (written elsewhere and renamed over the old path) keeps playing the old version until the response ends; new requests get 409 `TRACK_CHANGED` until the library is rescanned. A file rewritten in place is detected after every read: if nothing was sent yet the client gets 409 `TRACK_CHANGED`, otherwise the connection is closed, so a client never receives a mix of old and new bytes. Copy new music into the library with an atomic rename (for example `rsync`, which does this by default) rather than overwriting files in place.

`src/version-cache.ts` (a bounded, crash-safe disk cache of immutable track versions) is not used for local files. It is kept for future sources without cheap random access, such as cloud storage. Sources have an independent `StorageAdapter` contract; cloud providers are not implemented.

## Tests

```sh
npm test
```

Tests generate WAV fixtures and use temporary SQLite databases. They exercise Fastify injection and real HTTP requests to an ephemeral localhost port, including twenty listeners playing twenty different tracks at once, client disconnects, atomic and in-place file changes during playback, rescans, seek ranges, errors, traversal and symlink escapes. The cache module has its own quota and SIGKILL recovery tests. The HTTP suite prints STREAM_METRICS with time from request to first body byte (TTFB), RSS and process descriptor counts; results depend on CPU, filesystem and runner load, and RSS includes the test clients and generated fixtures. A real Android client, physical network, reverse proxy, cloud sources, authentication and updater are outside this stage.

Time to first audio byte on one Linux VM (Node 24.22.1, file already in the page cache, after a warm-up request), compared with the previous copy-to-cache implementation:

| Track size | Copy to cache first (v0.1.0) | Direct streaming |
| ---: | ---: | ---: |
| 8 MB | 247 ms | 22 ms |
| 150 MB | 6,009 ms | 15 ms |

This is a single local sample, not a throughput benchmark or a prediction for real devices or networks.
