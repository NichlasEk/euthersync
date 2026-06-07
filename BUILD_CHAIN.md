# EutherSync Build Chain

EutherSync has two separate pieces:

- `apps/euthersync`: the web app that the EutherSync Android wrapper loads.
- `apps/euthersync-android`: the small Android WebView wrapper APK.

Do not confuse this with the root EutherHost UI in `webview/main.ts`. Changes to `webview/main.ts` are not visible in EutherSync unless the Android wrapper is deliberately pointed at EutherHost instead of `/euthersync`.

## Normal Update Flow

1. Edit the EutherSync web app:
   - `apps/euthersync/public/index.html`
   - `apps/euthersync/public/app.js`
   - `apps/euthersync/public/styles.css`
   - `apps/euthersync/server/index.js`

2. If server behavior changed, restart the Node service:
   ```sh
   sudo -S systemctl restart euthersync
   ```

3. Verify the public web route:
   ```sh
   curl -k -I https://apothictech.se/euthersync/
   curl -k https://apothictech.se/euthersync/health
   ```

4. Rebuild the APK only when the wrapper itself changed, or when its endpoint list must change:
   ```sh
   npm run android:euthersync
   ```

5. Confirm the downloadable APK paths were updated:
   ```sh
   ls -lh /home/nichlas/EutherSync-release-signed.apk
   ls -lh /home/nichlas/EutherOxide/apps/euthersync/releases/EutherSync-release-signed.apk
   ```

## Endpoint Rule

The APK gets its URL list from `scripts/euthersync-release-apk.sh`.

Default:
```text
http://192.168.32.186:3000,https://apothictech.se/euthersync/
```

That means the APK loads `apps/euthersync`, not root EutherHost.

To override endpoints for one build:
```sh
EUTHERSYNC_ANDROID_URLS="http://192.168.32.186:3000,https://apothictech.se/euthersync/" npm run android:euthersync
```

## User Settings

EutherSync user preferences should be saved in the same user TOML used by EutherHost:

```text
.euther-host/user-data/<user>/settings.toml
```

Current appearance fields:
```toml
theme = "light"
skin = "classic"
```

The `euthersync` service must be allowed to write `.euther-host/user-data` if it saves these fields.
