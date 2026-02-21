# iniManager v2.5.1 – Renderer API & Architecture Analysis

Status: completed (static source code analysis of the renderer bundle)
Date: 2026-02-21
Source: `.webpack/renderer/main_window/main-DW2X4UID.js` (7 MB, plain-text JS)
Method: Regex/pattern extraction from minified Angular bundle

---

## 1. Base URLs

| Purpose | URL |
|---|---|
| **API Root** | `https://manager.inibuilds.com/api/v4/` |
| **Analytics** | `https://analytics.inibuilds.com/api/` |
| **Shopify StoreFront** | `https://inibuilds-store.myshopify.com/api/graphql` |
| **UK geo-check** | `https://d2br80tmjwggew.cloudfront.net/` |
| **Static assets** | `https://manager.inibuilds.com/api/public/…` |

Shopify Storefront API Token: `b17f49a46527a923b9ba9b7b67db1df4`

---

## 2. All API Endpoints (iniBuilds Backend)

All relative to `API_ROOT` = `https://manager.inibuilds.com/api/v4/`

### Config Object (`this.URL`)

| Key | Path Segment | HTTP Method | Purpose |
|---|---|---|---|
| `login` | `login` | POST | Generate device ID (auth) |
| `config` | `config` | POST | Fetch app configuration |
| `companies` | `companies` | POST | Fetch companies/vendors |
| `carousels` | `carousels` | POST | Fetch home carousels |
| `filesUrl` | `filesUrl` | **IPC** (no HTTP from renderer) | Product download – URL passed to main process |
| `liveriesUrl` | `liveriesUrl` | **IPC** | Livery download – URL passed to main process |
| `gsxProfiles` | `gsxProfiles` | POST | List GSX profiles |
| `gsxProfileUrl` | `gsxProfileUrl` | **IPC** | GSX profile download URL |
| `fcm_token` | `fcm-token` | POST | Register Firebase Cloud Messaging token |
| `avatar` | `avatar` | POST | Upload user avatar |
| `checkout_url` | `create-checkout` | POST | Create draft checkout (body: `{variantIds}`) |

### Static Assets (direct GET requests)

| URL | Purpose |
|---|---|
| `https://manager.inibuilds.com/api/public/scenery_configs.json` | Scenery configuration data |
| `https://manager.inibuilds.com/api/public/default-user-icon.png` | Default avatar |
| `https://manager.inibuilds.com/api/public/checkout.css` | Checkout styling |
| `https://manager.inibuilds.com/api/public/checkout-dark.css` | Checkout dark theme |
| `https://manager.inibuilds.com/api/public/checkout.js` | Checkout logic |

### Analytics Endpoints (`STAT_API_URL` = `https://analytics.inibuilds.com/api/`)

| Key | Path | Method | Purpose |
|---|---|---|---|
| `download` | `record-download` | GET (query params) | Track download |
| `uninstall` | `record-uninstall` | GET (query params) | Track uninstall |
| `sale` | `record-sale` | GET (query params) | Track sale |
| `active` | `active` | GET (query params) | Heartbeat/active ping |
| `event` | `event-sale` | GET | Fetch available sale events |

---

## 3. Authentication Mechanism

### Flow

1. **Shopify GraphQL Auth** – user enters email + password
   - Mutation: `customerAccessTokenCreate` with `CustomerAccessTokenCreateInput` (`email`, `password`)
   - Returns: `customerAccessToken` with `accessToken` and `expiresAt`
   - Token stored via `electron.settings.set("accessToken", ...)`

2. **iniBuilds Device Registration** – after successful Shopify auth
   - POST to `{API_ROOT}login` with body: `{accessToken: <shopify_access_token>}`
   - Returns: `{token: <deviceId>, user: <userObject>}`
   - `deviceId` stored via `electron.setDeviceId(token)`
   - `user` stored via `electron.setUser(user)`
   - Credentials stored: `electron.setCredentials({email, password})`

3. **HTTP Interceptor** (Angular)
   - Every HTTP request except `AUTH_EXCLUDED` patterns (`"/login"`, `"d2br80tmjwggew"`)
   - Sets header: `Authorization: <deviceId>`
   - On 401 response → forced logout, navigation to `/auth`

4. **Token Renewal**
   - Shopify mutation: `customerAccessTokenRenew` with current `accessToken`
   - On failure → re-authentication with stored credentials

5. **409 Conflict Handling**
   - Interceptor checks for 409 status
   - If `error.required === "UPGRADE"` → forced upgrade dialog

### Auth Summary

```
Shopify Auth (email+password) → Shopify accessToken
  ↓
POST /api/v4/login {accessToken} → deviceId + user
  ↓
All subsequent requests: Authorization: <deviceId>
```

---

## 4. File Download / Install Flow

### Product Installation

1. **Renderer** creates payload:
   ```js
   {
     request_url: API_ROOT + "filesUrl",   // https://manager.inibuilds.com/api/v4/filesUrl
     productId: product.id,
     full: boolean,                         // true = fresh install, false = update
     simulator: product.simulator,
     is_executable: product.is_executable,
     token: electron.getDeviceId(),         // deviceId for auth
     platform: electron.getPlatform(),
     custom_location: product.custom_location,
     installPath: <resolved_path>,
     needs_elevation: boolean               // from settings
   }
   ```

2. **Renderer** sends via IPC: `electron.installProduct(payload)`
   → `ipcRenderer.send("installProduct", payload)`

3. **Main process** handles `installProduct` IPC event
   - Downloads files from `request_url`
   - Sends progress back via: `ipcRendererOn("installProgress", ...)`

### Livery Installation

Same pattern, but:
- `request_url: API_ROOT + "liveriesUrl"`
- Body contains `liveryId` instead of `productId`
- IPC: `ipcRenderer.send("installLivery", payload)`

### GSX Profile Installation

- `request_url: API_ROOT + "gsxProfileUrl"`
- Body contains `gsXProfileId`, `dir_name` (file list), hardcoded `simulator: "MSFS2020"`
- IPC: `ipcRenderer.send("installProfile", payload)`

### Queue System

- Only ONE installation at a time (`isInstallActive` flag)
- Items enqueued in `installationQueue[]`
- Queue processed sequentially
- Queue item types: products, liveries, GSX profiles

### Installation Control

- **Cancel**: `ipcRenderer.send("abortInstallation")`
- **Progress**: `ipcRendererOn("installProgress", callback)`

### Uninstallation

- Products: `ipcRenderer.invoke("uninstallProduct", {simulatorPath, directoryPaths, file_replace_tag})`
- Liveries: `ipcRenderer.send("uninstallLivery", {simulatorPath, directoryPaths})`
- GSX: `ipcRenderer.send("uninstallProfile", ...)`

---

## 5. IPC Bridge (preload.js)

### Main Window Preload

Exposes `window.electron` with:
```js
{
  ipcRenderer: {
    send(channel, ...args),       // fire-and-forget
    invoke(channel, ...args),     // request-response (Promise)
    sendSync(channel, ...args),   // synchronous
  },
  ipcRendererOn(channel, callback),   // Main→Renderer events
  ipcRendererOnce(channel, callback), // one-time listener
}
```

**IMPORTANT**: No channel whitelist in preload – ALL channels are passed through.

### Checkout Window Preload

Minimal bridge:
```js
// Listens for window.postMessage with type "isThankYouPage"
// Forwards to: ipcRenderer.send("isThankYouPage", url)
```

---

## 6. All IPC Channels

### Renderer → Main (send, fire-and-forget)

| Channel | Purpose |
|---|---|
| `installProduct` | Start product download/installation |
| `installLivery` | Start livery download/installation |
| `installProfile` | Start GSX profile installation |
| `abortInstallation` | Cancel active installation |
| `uninstallLivery` | Remove livery files |
| `uninstallProfile` | Remove GSX profile |
| `checkForUpdates` | Check for app updates |
| `processPayment` | Open checkout window with URL |
| `cancelCheckout` | Cancel checkout |
| `processServerConfig` | Process server configuration |
| `clearAllSettings` | Clear all settings |
| `setSettingValue` | Store a setting |
| `findPath` | Find filesystem path |
| `launchExternal` | Open external URL |
| `close` | Close window |
| `minimize` | Minimize window |
| `resize` | Resize window |
| `focusme` | Focus window |
| `forceUpgrade` | Force app upgrade |
| `saveDebug` | Log debug data |
| `addToLayoutJSON` | Add entry to MSFS layout.json |
| `removeFromLayoutJSON` | Remove from layout.json |
| `rebuildLayoutJSON` | Rebuild layout.json |
| `deleteGSXFiles` | Delete GSX files |
| `PUSH_RECEIVER:::START_NOTIFICATION_SERVICE` | Start FCM push service |

### Renderer → Main (invoke, returns Promise)

| Channel | Returns |
|---|---|
| `uninstallProduct` | Uninstallation result |
| `verifyInstallation` | Verification status |
| `detectVersion` | Product version information |
| `getSimProductsList` | Sim product list |
| `openExternalLink` | Opens URL (validated) |
| `getSettingValue` | Setting value |
| `deleteSettingValue` | Deletion result |
| `setSettingValue` | Set result |
| `readProductConfig` | Product configuration data |
| `updateSceneryConfigs` | Scenery config result |
| `verifyPathParts` | Path validation |
| `renamePath` | Rename result |
| `allProductsData` | All product data |
| `getDuplicateGSX` | Duplicate GSX check |
| `scanGSXProfiles` | Scan GSX profiles |
| `handelSymLink` | Symlink handling |

### Renderer → Main (sendSync, blocking)

| Channel | Returns |
|---|---|
| `appVersion` | App version string |
| `verifyPath` | Path existence |
| `verifyPathSync` | Sync path check |
| `verifyXPlanePath` | X-Plane path validation |
| `verifyPrepar3DPath` | P3D path validation |
| `openPathDialog` | Native file dialog result |
| `pathBuilder` | Constructed path |
| `directoryWritePermissions` | Write permission check |
| `simRunning` | Sim running status |
| `nativeTheme` | Current theme |
| `lookupMetar` | METAR data |
| `lookupTaf` | TAF data |
| `lookupAtis` | ATIS data |
| `requestSimBriefXML` | SimBrief flight plan |
| `exportFMSPlan` | FMS plan export |
| `getSettingValue` | Setting value (sync) |

### Main → Renderer (Events)

| Channel | Data |
|---|---|
| `installProgress` | Download/installation progress |
| `checkoutProgress` | Checkout status |
| `updateDownloads` | App update download progress |
| `noUpdateDownloads` | No updates available |
| `PUSH_RECEIVER:::NOTIFICATION_SERVICE_STARTED` | FCM token |
| `PUSH_RECEIVER:::NOTIFICATION_SERVICE_ERROR` | Push error |
| `PUSH_RECEIVER:::NOTIFICATION_RECEIVED` | Push notification |
| `PUSH_RECEIVER:::TOKEN_UPDATED` | Updated FCM token |

---

## 7. Electron Settings (Persistent Storage)

Key settings stored via `electron-store` or similar mechanism:

| Key | Purpose |
|---|---|
| `accessToken` | Shopify access token |
| `deviceId` | iniBuilds device/auth ID |
| `user` | User object |
| `userCredentials` | `{email, password}` for token renewal |
| `simPaths` | Configured simulator paths |
| `installedProducts` | List of installed products |
| `installedLiveries` | List of installed liveries |
| `installedgsxprofiles` | List of installed GSX profiles |
| `companies` | Cached company data |
| `cart` | Shopping cart state |
| `themeMode` | Light/dark theme |
| `favouriteProducts` | Favorited product IDs |
| `productFilters` | Product filter settings |
| `ToSAgreement` | ToS accepted |
| `appCurrency` | Currency preference |
| `notificationsDisabled` | Push notification toggle |
| `newsTime` | Timestamp of last news |
| `hideOwnedSetting` | Hide owned products |
| `simbrief.identifier` | SimBrief user ID |
| `useAltDownloader` | Alternative downloader toggle |
| `sceneryMapOwned` | Owned sceneries |
| `sceneryMapSelected` | Selected sceneries |
| `debugData` | Debug log data |

---

## 8. Relevance for aerosync-addon-updater

1. **Auth model**: Two-stage – Shopify token → device ID registration → deviceId as `Authorization` header. Our `inibuilds-client.js` interacts with the same `/api/v4/` backend.

2. **Downloads in the main process**: The renderer only sends `request_url` + metadata via IPC. The actual HTTP file downloads happen in the **main process** (V8 bytecode, not extractable from renderer JS).

3. **Endpoint paths are segments**, not full paths. E.g. `filesUrl` becomes `https://manager.inibuilds.com/api/v4/filesUrl`.

4. **No explicit file-list/check endpoint visible in the renderer**. The `filesUrl`/`liveriesUrl`/`gsxProfileUrl` endpoints are passed as `request_url` in IPC payloads. The main process presumably POSTs to these URLs to obtain file manifests.

5. **Purchase flow** uses Shopify Storefront API GraphQL for cart/checkout, then `create-checkout` on the iniBuilds API.

6. **No channel whitelist** in `preload.js` – all IPC channels directly exposed (security-relevant, but fits the Angular architecture with a trusted renderer).

7. **Config constants**: `ID_CONSTANT=1e6`, `SPECIAL_VENDOR=41`, `LIVERY_PRODUCT_DIR_INDEX=306`, `FILE_REPLACE_TAG="FILE_REPLACE_TAG"`.

---

## 9. Known Gaps

- **Main process code** (`index.jsc`) is V8 bytecode – the actual download/file-operation logic (manifest parsing, checksum validation, file write operations) cannot be directly extracted from it.
- **filesUrl response schema**: Known from proxy capture: at least `url`, `filename`, `productId`, `filesIntegrityHash`, `cacheTime`. Full schema unknown.
- **Token lifetime**: Shopify `expiresAt` visible, deviceId TTL unknown.
- **Rate limits**: No information from static analysis.
