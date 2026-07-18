# EutherSync

EutherSync is a private, self-hosted photo backup and family feed for the EutherOxide server. Backup and publishing are separate actions: uploads are private by default, and a feed post is created only when a signed-in user explicitly publishes an uploaded item.

## MVP

- Node server with no runtime package dependencies.
- `/health` endpoint for EutherWormhole route checks.
- Login and cookie session handling.
- Role/permission separation for feed access, private backup, and admin grants.
- Binary photo/video upload with client-side SHA256 and server verification.
- Duplicate detection by SHA256 per user/device manifest.
- JSON manifest per user/device.
- Private media library.
- Intentional publish action from private library to family feed.
- Chronological family feed.
- EutherWormhole LAN-first/public fallback abstraction in `public/wormhole.js`.

## Local Run

```sh
cd apps/euthersync
cp config.example.json config.json
npm run dev
```

Default development login:

```text
username: nichlas
password: change-me-now
```

Change the password before using this beyond local testing. You can also set it through environment variables before the first run:

```sh
EUTHERSYNC_DEFAULT_USER=nichlas \
EUTHERSYNC_DEFAULT_NAME=Nichlas \
EUTHERSYNC_DEFAULT_PASSWORD='replace-this' \
npm run dev
```

## Android Release APK

The EutherOxide frontend download button points at
`/downloads/EutherSync-release-signed.apk`.
The EutherOxide host serves that route from:

```text
/home/nichlas/EutherSync-release-signed.apk
```

Build and publish the WebView wrapper APK with:

```sh
npm run android:release
```

The same pipeline is also available from the EutherOxide repo root:

```sh
npm run android:euthersync
```

To rebuild both fronted Android downloads from the EutherOxide repo root:

```sh
npm run android:release-apks
```

By default the Android wrapper tries these endpoints in order:

```text
http://192.168.32.186:3000
https://apothictech.se/euthersync/
```

Override that at build time when needed:

```sh
EUTHERSYNC_ANDROID_URL=https://photos.example.com npm run android:release
```

The release script writes both:

```text
/home/nichlas/EutherSync-release-signed.apk
apps/euthersync/releases/EutherSync-release-signed.apk
```

The host server first honors `EUTHERSYNC_APK_PATH`, then falls back to the
home-path APK, then to the repo release copy.

## Configuration

EutherSync reads `config.json` in the project directory unless `EUTHERSYNC_CONFIG` points elsewhere. Environment variables override the file:

- `EUTHERSYNC_HOST`
- `EUTHERSYNC_PORT`
- `EUTHERSYNC_STORAGE`
- `EUTHERSYNC_LOCAL_URL`
- `EUTHERSYNC_PUBLIC_URL`
- `EUTHERSYNC_HOST_USERS`
- `EUTHERSYNC_HOST_VERIFY_BIN`
- `EUTHERSYNC_HOST_LOGIN_URL`
- `EUTHERSYNC_DEFAULT_USER`
- `EUTHERSYNC_DEFAULT_NAME`
- `EUTHERSYNC_DEFAULT_PASSWORD`

When `EUTHERSYNC_HOST_USERS` points at the EutherOxide `users.toml`, EutherSync
uses that TOML file as the source for users, permissions, and password hashes.
Host-user passwords are delegated over localhost to EutherOxide's app-login route;
the standalone verifier remains as a compatibility fallback.
The verifier binary set by `EUTHERSYNC_HOST_VERIFY_BIN` checks the Argon2id
password hashes, reading the attempted password from stdin.

Example:

```json
{
  "host": "0.0.0.0",
  "port": 3000,
  "storagePath": "/srv/euther-sync",
  "localUrl": "http://eutheroxide.local:3000",
  "publicUrl": "https://photos.example.com",
  "defaultUser": {
    "id": "nichlas",
    "displayName": "Nichlas",
    "password": "change-me-now",
    "permissions": {
      "feed_read": true,
      "feed_post": true,
      "media_backup": true,
      "admin": true
    }
  }
}
```

## Permissions

All logged-in users are intended to read and post to the family feed. Private backup is explicit:

```json
{
  "permissions": {
    "feed_read": true,
    "feed_post": true,
    "media_backup": false,
    "admin": false
  }
}
```

- `feed_read`: can view the family feed and feed media.
- `feed_post`: can create text feed posts.
- `media_backup`: can see upload/library UI, upload media, view their private backup library, and publish their own backed-up media.
- `admin`: can list users and grant or revoke `media_backup`.

Backup storage remains private per user under `library/<user-id>/`. Publishing from backed-up private media requires ownership of that media.

## Storage Layout

```text
/srv/euther-sync/
  config/
    sessions.json
  users/
    nichlas.json
  devices/
  library/
    nichlas/
      web/
        photos/
        videos/
        manifest.json
  feed/
    posts/
    media/
    thumbnails/
```

Manifest entries use JSON for the first version:

```json
{
  "device": {
    "id": "web",
    "name": "Web upload",
    "owner": "nichlas"
  },
  "files": [
    {
      "id": "file-id",
      "originalName": "IMG_20260605_093012.jpg",
      "relativePath": "photos/2026/06/file-id-IMG_20260605_093012.jpg",
      "sha256": "...",
      "size": 3849231,
      "mimeType": "image/jpeg",
      "createdAt": "2026-06-05T09:30:12.000Z",
      "uploadedAt": "2026-06-05T09:35:00.000Z",
      "backedUp": true,
      "published": false
    }
  ]
}
```

## EutherWormhole

The web client loads `/api/config`, health-checks configured endpoints, and chooses the first working route by priority and latency. The normal UI only shows:

- `Connected locally`
- `Connected via public server`
- `Offline`

The abstraction is intentionally small so later transports can plug in behind the same route/status interface: WebRTC data channels, WebTransport/QUIC, peer-to-peer sync, and local-first/CRDT sync.

## Caddy

Example public HTTPS reverse proxy:

```caddyfile
photos.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

Example LAN name with Caddy handling plain local traffic is usually unnecessary if you bind EutherSync directly on the LAN. If Caddy fronts both local and public names, keep `/health` reachable on both routes so EutherWormhole can select the best working endpoint.

For larger uploads, configure request body limits intentionally in your proxy/firewall setup. EutherSync streams uploads to disk and verifies SHA256 after receiving the file.

## Notes

- Thumbnail generation is scaffolded in the storage layout but not implemented yet. The UI shows original media previews.
- Invited family users are represented by authenticated accounts in this milestone; multi-user invitation management is a later step.
- Sessions are stored in JSON for MVP simplicity. Move them to a database or signed/rotating session store before exposing this to untrusted networks.
