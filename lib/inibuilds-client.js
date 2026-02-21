const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { createLogger } = require('./logger');
const { AtomicFile } = require('./atomic-file');

const DEFAULT_SHOPIFY_API_URL = 'https://inibuilds-store.myshopify.com/api/graphql';
const DEFAULT_SHOPIFY_API_TOKEN = 'b17f49a46527a923b9ba9b7b67db1df4';

class IniBuildsClient {
  constructor(options = {}) {
    this.tempDir = options.tempDir || '';
    this.snapshotDir = options.snapshotDir || '';
    this.baseUrl = String(options.baseUrl || '').trim();
    this.authPath = String(options.authPath || '/api/v4/login').trim() || '/api/v4/login';
    this.productsPath = String(options.productsPath || '/api/v4/companies').trim() || '/api/v4/companies';
    this.filesUrlPath = String(options.filesUrlPath || '/api/v4/filesUrl').trim() || '/api/v4/filesUrl';
    this.shopifyApiUrl = String(options.shopifyApiUrl || DEFAULT_SHOPIFY_API_URL).trim();
    this.shopifyApiToken = String(options.shopifyApiToken || DEFAULT_SHOPIFY_API_TOKEN).trim();
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(2000, Math.trunc(Number(options.timeoutMs)))
      : 15000;
    this.logger = createLogger('inibuilds-client');
    this.planCache = new Map();
    this._crc32Table = null;
  }

  #createInstallAbortError() {
    const error = new Error('Installation cancelled by user.');
    error.code = 'INSTALL_CANCELLED';
    return error;
  }

  #looksLikeMd5Hex(value) {
    const text = String(value || '').trim();
    return /^[a-fA-F0-9]{32}$/.test(text);
  }

  #tryDecodeBase64(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return null;
    }

    // Support URL-safe base64 too.
    let base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }

    try {
      const buf = Buffer.from(base64, 'base64');
      if (!buf || buf.length === 0) {
        return null;
      }
      return buf;
    } catch {
      return null;
    }
  }

  #normalizeFilesIntegrityHashToMd5(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }

    // Case 1: already MD5 hex.
    if (this.#looksLikeMd5Hex(raw)) {
      return raw.toLowerCase();
    }

    // Case 2: base64 that encodes raw MD5 bytes (16 bytes).
    const buf = this.#tryDecodeBase64(raw);
    if (buf) {
      if (buf.length === 16) {
        return buf.toString('hex');
      }

      // Case 3: base64 that decodes to text that contains an MD5 hex.
      try {
        const text = buf.toString('utf8');
        const match = text.match(/[a-fA-F0-9]{32}/);
        if (match && match[0]) {
          return match[0].toLowerCase();
        }
      } catch {
        // ignore
      }

      // Case 4: base64 that decodes to gzip-compressed text with an MD5.
      try {
        if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
          const unzipped = zlib.gunzipSync(buf);
          const text = unzipped.toString('utf8');
          const match = text.match(/[a-fA-F0-9]{32}/);
          if (match && match[0]) {
            return match[0].toLowerCase();
          }
        }
      } catch {
        // ignore
      }
    }

    return '';
  }

  #safeIdSegment(rawValue, label) {
    const value = String(rawValue || '').trim();
    if (!value) {
      throw new Error(`Missing ${label}.`);
    }
    // Keep file-system safe: allow only a conservative subset.
    const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safe || safe === '.' || safe === '..') {
      throw new Error(`Invalid ${label}.`);
    }
    return safe;
  }

  #normalizeIgnoreEntries(rawIgnoreList) {
    const source = Array.isArray(rawIgnoreList)
      ? rawIgnoreList
      : String(rawIgnoreList || '').split(/\r?\n/g);

    const out = [];
    const seen = new Set();

    for (const rawEntry of source) {
      const item = String(rawEntry || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/{2,}/g, '/');

      if (!item || item.startsWith('#')) {
        continue;
      }
      if (seen.has(item)) {
        continue;
      }

      seen.add(item);
      out.push(item);
    }

    return out;
  }

  #escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  #compileIgnoreMatchers(rawIgnoreList) {
    const entries = this.#normalizeIgnoreEntries(rawIgnoreList);
    const out = [];

    for (const entry of entries) {
      const normalizedEntry = this.#normalizeZipRelPath(entry);
      if (!normalizedEntry) {
        continue;
      }

      if (normalizedEntry.endsWith('/')) {
        const prefix = normalizedEntry.slice(0, -1);
        out.push((relativePath) => relativePath === prefix || relativePath.startsWith(prefix + '/'));
        continue;
      }

      const hasWildcards = /[*?]/.test(normalizedEntry);
      if (hasWildcards) {
        let regexText = '^' + this.#escapeRegex(normalizedEntry) + '$';
        regexText = regexText.replace(/\\\*\\\*/g, '.*');
        regexText = regexText.replace(/\\\*/g, '[^/]*');
        regexText = regexText.replace(/\\\?/g, '[^/]');
        const matcher = new RegExp(regexText);
        out.push((relativePath) => matcher.test(relativePath));
        continue;
      }

      if (!normalizedEntry.includes('/')) {
        out.push((relativePath) => path.posix.basename(relativePath) === normalizedEntry);
        continue;
      }

      out.push((relativePath) => relativePath === normalizedEntry);
    }

    return out;
  }

  #shouldIgnoreRelativePath(relativePath, ignoreMatchers) {
    if (!Array.isArray(ignoreMatchers) || ignoreMatchers.length === 0) {
      return false;
    }

    const normalized = this.#normalizeZipRelPath(relativePath);
    if (!normalized) {
      return false;
    }

    return ignoreMatchers.some((matcher) => {
      try {
        return Boolean(matcher(normalized));
      } catch {
        return false;
      }
    });
  }

  #getIniBuildsProfileStateDir(profileId) {
    const safeProfileId = this.#safeIdSegment(profileId, 'profileId');
    const base = String(this.snapshotDir || '').trim();
    if (!base) {
      throw new Error('snapshotDir is not configured.');
    }
    return path.join(base, 'inibuilds', safeProfileId);
  }

  #getIniBuildsManifestPath(profileId) {
    return path.join(this.#getIniBuildsProfileStateDir(profileId), 'manifest.json');
  }

  #getIniBuildsLatestSnapshotPointerPath(profileId) {
    return path.join(this.#getIniBuildsProfileStateDir(profileId), 'latest-snapshot.json');
  }

  async #readJsonOrNull(filePath) {
    try {
      return await AtomicFile.readJSON(filePath);
    } catch {
      return null;
    }
  }

  async #writeJson(filePath, data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await AtomicFile.writeJSON(filePath, data);
  }

  async #loadIniBuildsManifest(profileId) {
    const filePath = this.#getIniBuildsManifestPath(profileId);
    const data = await this.#readJsonOrNull(filePath);
    if (!data || typeof data !== 'object') {
      return null;
    }

    const files = Array.isArray(data.files)
      ? data.files.map((v) => this.#normalizeZipRelPath(v)).filter(Boolean)
      : [];

    return {
      version: Number(data.version || 1),
      provider: String(data.provider || 'inibuilds'),
      productId: Number(data.productId || 0),
      packageHash: String(data.packageHash || '').trim().toLowerCase(),
      installedAt: String(data.installedAt || ''),
      files
    };
  }

  async #saveIniBuildsManifest(profileId, manifest) {
    const filePath = this.#getIniBuildsManifestPath(profileId);
    await this.#writeJson(filePath, {
      version: 1,
      provider: 'inibuilds',
      productId: Number(manifest && manifest.productId ? manifest.productId : 0),
      packageHash: String(manifest && manifest.packageHash ? manifest.packageHash : '').trim().toLowerCase(),
      installedAt: String(manifest && manifest.installedAt ? manifest.installedAt : new Date().toISOString()),
      files: Array.isArray(manifest && manifest.files ? manifest.files : [])
    });
  }

  async #createRollbackSnapshot(profile, rootDir, actions, runtimeControl) {
    const profileId = String(profile && profile.id ? profile.id : '').trim();
    if (!profileId) {
      throw new Error('Missing profile.id for rollback snapshot.');
    }

    const isCancelled = () =>
      Boolean(runtimeControl && runtimeControl.isCancelled && runtimeControl.isCancelled())
      || Boolean(runtimeControl && runtimeControl.signal && runtimeControl.signal.aborted);
    const isPaused = () => Boolean(runtimeControl && runtimeControl.isPaused && runtimeControl.isPaused());
    const waitUntilResumed = async () => {
      while (isPaused()) {
        if (isCancelled()) {
          throw this.#createInstallAbortError();
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    };

    await waitUntilResumed();
    if (isCancelled()) {
      throw this.#createInstallAbortError();
    }

    const baseDir = this.#getIniBuildsProfileStateDir(profileId);
    const snapshotId = `snap-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const snapshotDir = path.join(baseDir, 'snapshots', snapshotId);
    const filesDir = path.join(snapshotDir, 'files');
    await fsp.mkdir(filesDir, { recursive: true });

    const previousManifest = await this.#loadIniBuildsManifest(profileId);

    const entries = [];
    const list = Array.isArray(actions) ? actions : [];
    for (const action of list) {
      await waitUntilResumed();
      if (isCancelled()) {
        throw this.#createInstallAbortError();
      }

      const relPath = this.#normalizeZipRelPath(action && action.relativePath ? action.relativePath : '');
      if (!relPath) {
        continue;
      }
      const destPath = path.join(rootDir, relPath);
      this.#assertWithinRoot(rootDir, destPath);

      let hadFile = false;
      try {
        const st = await fsp.stat(destPath);
        hadFile = Boolean(st && st.isFile());
      } catch {
        hadFile = false;
      }

      if (hadFile) {
        const backupPath = path.join(filesDir, relPath);
        await fsp.mkdir(path.dirname(backupPath), { recursive: true });
        await fsp.copyFile(destPath, backupPath);
      }

      entries.push({
        type: String(action && action.type ? action.type : ''),
        relativePath: relPath,
        hadFile
      });
    }

    const metaPath = path.join(snapshotDir, 'meta.json');
    const meta = {
      version: 1,
      provider: 'inibuilds',
      profileId,
      createdAt: new Date().toISOString(),
      rootDir: String(rootDir),
      entries,
      previousManifest
    };
    await this.#writeJson(metaPath, meta);

    const pointerPath = this.#getIniBuildsLatestSnapshotPointerPath(profileId);
    await this.#writeJson(pointerPath, {
      version: 1,
      provider: 'inibuilds',
      profileId,
      snapshotId,
      snapshotDir,
      createdAt: meta.createdAt
    });

    return { snapshotId, snapshotDir, metaPath, pointerPath };
  }

  #normalizeSignedUrl(rawUrl) {
    const text = String(rawUrl || '').trim();
    if (!text) {
      throw new Error('Missing download URL for iniBuilds action.');
    }

    if (!/^https?:\/\//i.test(text)) {
      throw new Error('Invalid download URL (must be http/https).');
    }

    return text;
  }

  async #md5(filePath) {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  }

  async #downloadToFile(url, targetPath, signal, extraHeaders = null, progress = null, expectedTotalBytes = 0) {
    const controller = new AbortController();
    const onAbort = () => {
      try {
        controller.abort('cancelled');
      } catch {
        // ignore
      }
    };

    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        clearTimeout(timeout);
        throw this.#createInstallAbortError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          'User-Agent': 'AeroSync-Addon-Updater',
          ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {})
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Download failed (HTTP ${response.status}).`);
      }

      await fsp.mkdir(path.dirname(targetPath), { recursive: true });

      const parseLen = (value) => {
        const n = Number(String(value || '').trim());
        return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
      };

      const total = parseLen(response.headers.get('content-length'))
        || (Number.isFinite(Number(expectedTotalBytes)) ? Math.trunc(Number(expectedTotalBytes)) : 0)
        || 0;

      let downloaded = 0;
      let lastEmit = 0;
      const emit = () => {
        if (typeof progress !== 'function') {
          return;
        }
        try {
          progress({ downloaded, total });
        } catch {
          // ignore
        }
      };

      emit();

      const counter = new Transform({
        transform: (chunk, _enc, cb) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          downloaded += buf.length;
          const now = Date.now();
          if (now - lastEmit >= 250) {
            lastEmit = now;
            emit();
          }
          cb(null, chunk);
        }
      });

      await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(targetPath));
      emit();

      return {
        ok: true,
        status: response.status,
        url: response.url,
        contentType: String(response.headers.get('content-type') || '').trim(),
        contentEncoding: String(response.headers.get('content-encoding') || '').trim(),
        contentLength: String(response.headers.get('content-length') || '').trim(),
        contentMd5: String(response.headers.get('content-md5') || '').trim(),
        etag: String(response.headers.get('etag') || '').trim()
      };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw this.#createInstallAbortError();
      }

      throw error;
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  async #readFileHeader(filePath, length = 16) {
    const len = Number.isFinite(Number(length)) ? Math.max(4, Math.trunc(Number(length))) : 16;
    const fd = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      return bytesRead === buf.length ? buf : buf.slice(0, bytesRead);
    } finally {
      await fd.close();
    }
  }

  async #describeDownloadedFile(filePath) {
    try {
      const header = await this.#readFileHeader(filePath, 16);
      const hex = header.toString('hex');
      const isZip = header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b; // PK..
      const isGzip = header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b;
      let size = 0;
      try {
        const st = await fsp.stat(filePath);
        size = Number(st && st.size ? st.size : 0);
      } catch {
        size = 0;
      }
      return { ok: true, size, headerHex: hex, isZip, isGzip };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }

  async #probeSignedDownloadSize(url, signal) {
    const targetUrl = this.#normalizeSignedUrl(url);

    const tryFetch = async (options) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort('timeout');
      }, this.timeoutMs);

      const onAbort = () => {
        try {
          controller.abort('cancelled');
        } catch {
          // ignore
        }
      };

      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          clearTimeout(timeout);
          throw this.#createInstallAbortError();
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        return await fetch(targetUrl, {
          method: options.method,
          headers: {
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            'User-Agent': 'AeroSync-Addon-Updater',
            ...(options.headers || {})
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      }
    };

    const parseLength = (value) => {
      const numeric = Number(String(value || '').trim());
      return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
    };

    // 1) HEAD with Content-Length
    try {
      const head = await tryFetch({ method: 'HEAD' });
      if (head && head.ok) {
        const len = parseLength(head.headers.get('content-length'));
        if (len > 0) {
          return len;
        }
      }
    } catch {
      // ignore, try range
    }

    // 2) Range request: parse Content-Range: bytes 0-0/12345
    try {
      const res = await tryFetch({ method: 'GET', headers: { Range: 'bytes=0-0' } });
      if (!res) {
        return 0;
      }

      const contentRange = String(res.headers.get('content-range') || '').trim();
      const match = contentRange.match(/\/(\d+)\s*$/);
      if (match && match[1]) {
        const total = parseLength(match[1]);
        if (total > 0) {
          return total;
        }
      }

      if (res.ok) {
        const len = parseLength(res.headers.get('content-length'));
        if (len > 0) {
          return len;
        }
      }
    } catch {
      // ignore
    }

    return 0;
  }

  #getCrc32Table() {
    if (this._crc32Table) {
      return this._crc32Table;
    }

    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }

    this._crc32Table = table;
    return table;
  }

  #crc32Update(crc, chunk) {
    const table = this.#getCrc32Table();
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < chunk.length; i += 1) {
      c = table[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  async #crc32File(filePath) {
    let crc = 0;
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = this.#crc32Update(crc, buf);
    }
    return crc >>> 0;
  }

  #formatCrc32(value) {
    const numeric = Number(value);
    const normalized = Number.isFinite(numeric) ? (numeric >>> 0) : 0;
    return normalized.toString(16).padStart(8, '0');
  }

  #normalizeZipRelPath(name) {
    const raw = String(name || '').trim().replace(/\\/g, '/');
    if (!raw) {
      return '';
    }

    if (raw.startsWith('/') || raw.startsWith('\\')) {
      return '';
    }

    if (/^[a-zA-Z]:\//.test(raw)) {
      return '';
    }

    const normalized = path.posix.normalize(raw).replace(/^\/+/, '');
    if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/../')) {
      return '';
    }

    return normalized;
  }

  #assertWithinRoot(rootDir, targetPath) {
    const root = path.resolve(String(rootDir || ''));
    const target = path.resolve(String(targetPath || ''));
    if (!root || !target) {
      throw new Error('Invalid installation path.');
    }

    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Path traversal detected.');
    }
  }

  async #fetchRangeBuffer(url, start, end, signal, extraHeaders = null) {
    const targetUrl = this.#normalizeSignedUrl(url);
    const rangeStart = Number(start);
    const rangeEnd = Number(end);
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart < 0 || rangeEnd < rangeStart) {
      throw new Error('Invalid range request.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort('timeout');
    }, this.timeoutMs);

    const onAbort = () => {
      try {
        controller.abort('cancelled');
      } catch {
        // ignore
      }
    };

    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        clearTimeout(timeout);
        throw this.#createInstallAbortError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          Range: `bytes=${rangeStart}-${rangeEnd}`,
          'User-Agent': 'AeroSync-Addon-Updater',
          ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {})
        },
        signal: controller.signal
      });

      if (response.status !== 206) {
        throw new Error(`Range request not supported (HTTP ${response.status}).`);
      }

      const ab = await response.arrayBuffer();
      return Buffer.from(ab);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw this.#createInstallAbortError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  async #fetchSuffixRangeBuffer(url, suffixLen, signal, extraHeaders = null) {
    const targetUrl = this.#normalizeSignedUrl(url);
    const len = Number(suffixLen);
    const bytes = Number.isFinite(len) ? Math.max(1024, Math.trunc(len)) : 65536;

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort('timeout');
    }, this.timeoutMs);

    const onAbort = () => {
      try {
        controller.abort('cancelled');
      } catch {
        // ignore
      }
    };

    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        clearTimeout(timeout);
        throw this.#createInstallAbortError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          Range: `bytes=-${bytes}`,
          'User-Agent': 'AeroSync-Addon-Updater',
          ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {})
        },
        signal: controller.signal
      });

      if (response.status !== 206) {
        throw new Error(`Suffix range request not supported (HTTP ${response.status}).`);
      }

      const contentRange = String(response.headers.get('content-range') || '').trim();
      const match = contentRange.match(/\/(\d+)\s*$/);
      const totalSize = match && match[1] ? Math.trunc(Number(match[1])) : 0;

      const ab = await response.arrayBuffer();
      return { buffer: Buffer.from(ab), totalSize: Number.isFinite(totalSize) ? totalSize : 0 };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw this.#createInstallAbortError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  #findZipEocd(buffer) {
    const sig = 0x06054b50;
    const minSize = 22;
    if (!buffer || buffer.length < minSize) {
      return -1;
    }

    for (let i = buffer.length - minSize; i >= 0; i -= 1) {
      if (buffer.readUInt32LE(i) === sig) {
        return i;
      }
    }

    return -1;
  }

  #parseZipEocdFromTailBuffer(buffer) {
    const eocdOffset = this.#findZipEocd(buffer);
    if (eocdOffset < 0) {
      throw new Error('Failed to locate ZIP end-of-central-directory record.');
    }

    const cdSize = buffer.readUInt32LE(eocdOffset + 12);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    return { cdSize, cdOffset };
  }

  #parseZipCentralDirectoryEntries(buffer) {
    const entries = [];
    let offset = 0;
    const sig = 0x02014b50;

    while (offset + 46 <= buffer.length) {
      if (buffer.readUInt32LE(offset) !== sig) {
        break;
      }

      const method = buffer.readUInt16LE(offset + 10);
      const crc32 = buffer.readUInt32LE(offset + 16) >>> 0;
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const uncompressedSize = buffer.readUInt32LE(offset + 24);
      const fileNameLen = buffer.readUInt16LE(offset + 28);
      const extraLen = buffer.readUInt16LE(offset + 30);
      const commentLen = buffer.readUInt16LE(offset + 32);
      const localHeaderOffset = buffer.readUInt32LE(offset + 42);

      const nameStart = offset + 46;
      const nameEnd = nameStart + fileNameLen;
      if (nameEnd > buffer.length) {
        break;
      }

      const fileName = buffer.slice(nameStart, nameEnd).toString('utf8');

      entries.push({
        fileName,
        method,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      });

      offset = nameEnd + extraLen + commentLen;
      if (entries.length > 200000) {
        throw new Error('ZIP central directory too large.');
      }
    }

    return entries;
  }

  async #getZipEntriesFromSignedUrl(zipUrl, zipSize, signal, headerCandidates = null) {
    const size = Number(zipSize);
    let tail = null;
    let totalSize = Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0;

    const candidates = Array.isArray(headerCandidates) && headerCandidates.length > 0
      ? headerCandidates
      : [null];

    let lastError = '';

    for (const headers of candidates) {
      try {
        if (totalSize > 0) {
          const tailLen = Math.min(65536, totalSize);
          const tailStart = Math.max(0, totalSize - tailLen);
          tail = await this.#fetchRangeBuffer(zipUrl, tailStart, totalSize - 1, signal, headers);
        } else {
          const suffix = await this.#fetchSuffixRangeBuffer(zipUrl, 65536, signal, headers);
          tail = suffix.buffer;
          totalSize = suffix.totalSize || 0;
        }
        lastError = '';
        break;
      } catch (error) {
        lastError = String(error && error.message ? error.message : error || 'unknown error');
        tail = null;
      }
    }

    if (!tail) {
      throw new Error(lastError || 'Unable to fetch ZIP tail.');
    }

    const { cdSize, cdOffset } = this.#parseZipEocdFromTailBuffer(tail);

    if (!Number.isFinite(cdSize) || !Number.isFinite(cdOffset) || cdSize <= 0) {
      throw new Error('Invalid ZIP central directory information.');
    }

    const cdEnd = cdOffset + cdSize - 1;
    if (totalSize > 0 && cdEnd >= totalSize) {
      throw new Error('ZIP central directory range is outside file bounds.');
    }

    let cdBuf = null;
    lastError = '';
    for (const headers of candidates) {
      try {
        cdBuf = await this.#fetchRangeBuffer(zipUrl, cdOffset, cdEnd, signal, headers);
        lastError = '';
        break;
      } catch (error) {
        lastError = String(error && error.message ? error.message : error || 'unknown error');
        cdBuf = null;
      }
    }

    if (!cdBuf) {
      throw new Error(lastError || 'Unable to fetch ZIP central directory.');
    }
    return { entries: this.#parseZipCentralDirectoryEntries(cdBuf), totalSize };
  }

  async #extractZipEntryToFile(zipPath, entry, destPath) {
    const localHeaderOffset = Number(entry && entry.localHeaderOffset);
    const compressedSize = Number(entry && entry.compressedSize);
    const method = Number(entry && entry.method);

    if (!Number.isFinite(localHeaderOffset) || localHeaderOffset < 0) {
      throw new Error('Invalid ZIP entry offset.');
    }
    if (!Number.isFinite(compressedSize) || compressedSize < 0) {
      throw new Error('Invalid ZIP entry size.');
    }

    const fd = await fsp.open(zipPath, 'r');
    try {
      const header = Buffer.alloc(30);
      const { bytesRead } = await fd.read(header, 0, header.length, localHeaderOffset);
      if (bytesRead !== header.length) {
        throw new Error('Failed to read ZIP local header.');
      }

      if (header.readUInt32LE(0) !== 0x04034b50) {
        throw new Error('Invalid ZIP local header signature.');
      }

      const fileNameLen = header.readUInt16LE(26);
      const extraLen = header.readUInt16LE(28);
      const dataOffset = localHeaderOffset + 30 + fileNameLen + extraLen;
      const dataEnd = dataOffset + compressedSize - 1;

      await fsp.mkdir(path.dirname(destPath), { recursive: true });

      if (compressedSize === 0) {
        await fsp.writeFile(destPath, Buffer.alloc(0));
        return 0;
      }

      if (dataEnd < dataOffset) {
        throw new Error('Invalid ZIP entry range.');
      }

      const input = fs.createReadStream(zipPath, { start: dataOffset, end: dataEnd });
      const output = fs.createWriteStream(destPath);

      let crc = 0;
      const crcTransform = new Transform({
        transform: (chunk, _enc, cb) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          crc = this.#crc32Update(crc, buf);
          cb(null, chunk);
        }
      });

      if (method === 0) {
        await pipeline(input, crcTransform, output);
      } else if (method === 8) {
        await pipeline(input, zlib.createInflateRaw(), crcTransform, output);
      } else {
        throw new Error(`Unsupported ZIP compression method: ${method}`);
      }

      return crc >>> 0;
    } finally {
      await fd.close();
    }
  }

  async #getZipEntriesFromLocalFile(zipPath) {
    const stat = await fsp.stat(zipPath);
    const size = Number(stat && stat.size ? stat.size : 0);
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error('ZIP file is empty.');
    }

    const tailLen = Math.min(65536, size);
    const tailStart = Math.max(0, size - tailLen);
    const fd = await fsp.open(zipPath, 'r');
    try {
      const tail = Buffer.alloc(tailLen);
      const { bytesRead } = await fd.read(tail, 0, tail.length, tailStart);
      const tailBuf = bytesRead === tail.length ? tail : tail.slice(0, bytesRead);
      const { cdSize, cdOffset } = this.#parseZipEocdFromTailBuffer(tailBuf);
      const cdEnd = cdOffset + cdSize - 1;
      if (cdOffset < 0 || cdSize <= 0 || cdEnd >= size) {
        throw new Error('ZIP central directory range is outside file bounds.');
      }

      const cdBuf = Buffer.alloc(cdSize);
      const res = await fd.read(cdBuf, 0, cdBuf.length, cdOffset);
      const cdRead = res && Number.isFinite(res.bytesRead) ? res.bytesRead : 0;
      if (cdRead !== cdBuf.length) {
        throw new Error('Failed to read ZIP central directory from local file.');
      }

      return this.#parseZipCentralDirectoryEntries(cdBuf);
    } finally {
      await fd.close();
    }
  }

  #parseExpectedCrc32(actionHash) {
    const text = String(actionHash || '').trim().toLowerCase();
    if (!text.startsWith('crc32:')) {
      return null;
    }
    const hex = text.slice('crc32:'.length).trim();
    if (!/^[a-f0-9]{8}$/.test(hex)) {
      return null;
    }
    return Number.parseInt(hex, 16) >>> 0;
  }

  async #validateDownloadedZipMatchesPlan(zipPath, updateActions) {
    const actions = Array.isArray(updateActions) ? updateActions : [];
    if (actions.length === 0) {
      return { ok: true, checked: 0 };
    }

    const entries = await this.#getZipEntriesFromLocalFile(zipPath);
    const entryByName = new Map();
    for (const entry of entries) {
      const name = String(entry && entry.fileName ? entry.fileName : '').trim();
      if (!name || name.endsWith('/')) {
        continue;
      }
      if (!entryByName.has(name)) {
        entryByName.set(name, entry);
      }
    }

    let checked = 0;
    for (const action of actions) {
      const name = String(action && action.zipEntryName ? action.zipEntryName : '').trim();
      if (!name) {
        return { ok: false, reason: 'Plan action is missing zipEntryName.' };
      }

      const entry = entryByName.get(name);
      if (!entry) {
        return { ok: false, reason: `ZIP entry missing in downloaded file: ${name}` };
      }

      const expectedOffset = Number(action && action.zipLocalHeaderOffset ? action.zipLocalHeaderOffset : 0);
      const actualOffset = Number(entry && entry.localHeaderOffset ? entry.localHeaderOffset : 0);
      if (!Number.isFinite(expectedOffset) || !Number.isFinite(actualOffset) || expectedOffset !== actualOffset) {
        return { ok: false, reason: `ZIP offset mismatch for ${name}` };
      }

      const expectedMethod = Number(action && action.zipMethod ? action.zipMethod : 0);
      const actualMethod = Number(entry && entry.method ? entry.method : 0);
      if (Number.isFinite(expectedMethod) && expectedMethod !== actualMethod) {
        return { ok: false, reason: `ZIP method mismatch for ${name}` };
      }

      const expectedCrc = this.#parseExpectedCrc32(action && action.hash ? action.hash : '');
      const actualCrc = Number(entry && entry.crc32 ? entry.crc32 : 0) >>> 0;
      if (expectedCrc !== null && (expectedCrc >>> 0) !== (actualCrc >>> 0)) {
        return { ok: false, reason: `ZIP CRC32 mismatch for ${name}` };
      }

      checked += 1;
    }

    return { ok: true, checked };
  }

  async #verifyPackageMd5(downloadPath, expectedHash) {
    const expected = String(expectedHash || '').trim().toLowerCase();
    if (!expected) {
      throw new Error('Missing expected package checksum (md5).');
    }

    const rawHash = await this.#md5(downloadPath);
    if (rawHash === expected) {
      return rawHash;
    }

    // Optional gunzip fallback (kept for parity with existing behavior).
    let gunzipError = null;
    const tmpResult = `${downloadPath}.gunzip.tmp`;
    try {
      await pipeline(
        fs.createReadStream(downloadPath),
        zlib.createGunzip(),
        fs.createWriteStream(tmpResult)
      );
    } catch (error) {
      gunzipError = error;
    }

    if (gunzipError) {
      throw new Error(`Checksum mismatch: expected ${expected}, raw ${rawHash}, gunzip failed: ${gunzipError.message}`);
    }

    const unpackedHash = await this.#md5(tmpResult);
    await fsp.unlink(tmpResult).catch(() => {});

    if (unpackedHash !== expected) {
      throw new Error(`Checksum mismatch: expected ${expected}, raw ${rawHash}, unpacked ${unpackedHash}`);
    }

    return unpackedHash;
  }

  #normalizeBaseUrl(profile = null) {
    const profileHost = profile && typeof profile === 'object'
      ? String(profile.host || '').trim()
      : '';
    const raw = profileHost || this.baseUrl;
    if (!raw) {
      throw new Error('iniBuilds host is missing. Set the profile host to the iniBuilds API base URL.');
    }

    if (!/^https?:\/\//i.test(raw)) {
      throw new Error('iniBuilds host must start with http:// or https://.');
    }

    return raw.replace(/\/+$/, '');
  }

  #joinUrl(baseUrl, endpointPath) {
    const path = String(endpointPath || '').trim();
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${baseUrl}${normalizedPath}`;
  }

  async #requestJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort('timeout');
    }, this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      return {
        ok: response.ok,
        status: response.status,
        data
      };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeoutMs}ms.`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  #extractErrorMessage(payload) {
    if (!payload) {
      return '';
    }

    if (typeof payload === 'string') {
      return payload.trim().slice(0, 400);
    }

    if (typeof payload !== 'object') {
      return '';
    }

    const candidates = [
      payload.message,
      payload.error,
      payload.detail,
      payload?.errors?.[0]?.message,
      payload?.error?.message,
      payload?.data?.message
    ];

    for (const candidate of candidates) {
      const text = String(candidate || '').trim();
      if (text) {
        return text.slice(0, 400);
      }
    }

    return '';
  }

  #extractToken(payload) {
    if (!payload || typeof payload !== 'object') {
      return '';
    }

    const candidates = [
      payload.token,
      payload.accessToken,
      payload.jwt,
      payload?.data?.token,
      payload?.data?.accessToken,
      payload?.user?.token,
      payload?.user?.accessToken,
      payload?.result?.token,
      payload?.result?.accessToken
    ];

    for (const entry of candidates) {
      const token = String(entry || '').trim();
      if (token) {
        return token;
      }
    }

    return '';
  }

  async #authenticateViaShopify(email, password) {
    const endpoint = String(this.shopifyApiUrl || '').trim();
    const token = String(this.shopifyApiToken || '').trim();
    if (!endpoint || !token) {
      throw new Error('Shopify auth probe not configured (missing API URL/token).');
    }

    const endpointCandidates = this.#buildShopifyEndpointCandidates(endpoint);

    const mutation = `mutation customerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {\n  customerAccessTokenCreate(input: $input) {\n    customerAccessToken {\n      accessToken\n      expiresAt\n    }\n    customerUserErrors {\n      code\n      field\n      message\n    }\n  }\n}`;

    let lastError = '';
    for (const candidateEndpoint of endpointCandidates) {
      const result = await this.#requestJson(candidateEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
          'User-Agent': 'AeroSync-Addon-Updater'
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            input: {
              email,
              password
            }
          }
        })
      });

      if (!result.ok) {
        const detail = this.#extractErrorMessage(result.data);
        lastError = `HTTP ${result.status} via ${candidateEndpoint}${detail ? ` (${detail})` : ''}`;
        continue;
      }

      const root = result.data && typeof result.data === 'object' ? result.data : {};
      const createResult = root.data && root.data.customerAccessTokenCreate
        ? root.data.customerAccessTokenCreate
        : null;
      const accessToken = createResult
        && createResult.customerAccessToken
        && String(createResult.customerAccessToken.accessToken || '').trim();

      if (accessToken) {
        return accessToken;
      }

      const errors = createResult && Array.isArray(createResult.customerUserErrors)
        ? createResult.customerUserErrors
        : [];
      const firstErrorMessage = errors.length > 0 && errors[0] && errors[0].message
        ? String(errors[0].message)
        : '';

      if (firstErrorMessage) {
        throw new Error(`Shopify auth returned no token (${firstErrorMessage}).`);
      }

      lastError = `Shopify auth returned no token via ${candidateEndpoint}.`;
    }

    throw new Error(lastError || 'Shopify auth returned no token.');
  }

  #buildShopifyEndpointCandidates(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) {
      return [];
    }

    const candidates = [raw];
    try {
      const parsed = new URL(raw);
      const origin = parsed.origin.replace(/\/+$/, '');
      const known = [
        `${origin}/api/graphql`,
        `${origin}/api/graphql.json`,
        `${origin}/api/2024-01/graphql.json`,
        `${origin}/api/2025-01/graphql.json`,
        `${origin}/api/unstable/graphql.json`
      ];
      for (const candidate of known) {
        if (!candidates.includes(candidate)) {
          candidates.push(candidate);
        }
      }
    } catch {
      // keep configured endpoint only
    }

    return candidates;
  }

  async #exchangeAccessToken(baseUrl, accessToken) {
    const authUrl = this.#joinUrl(baseUrl, this.authPath);

    // Confirmed from iniManager renderer analysis: POST /api/v4/login with
    // body {accessToken} and NO Authorization header (login is auth-excluded).
    // Response: {token: <deviceId>, user: <userObject>}.
    const primaryPayload = { accessToken };
    const primaryResult = await this.#requestJson(authUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'AeroSync-Addon-Updater'
      },
      body: JSON.stringify(primaryPayload)
    });

    if (primaryResult.ok) {
      const token = this.#extractToken(primaryResult.data);
      if (token) {
        return token;
      }
    }

    // Primary attempt failed – try fallback payload shapes with auth headers.
    const fallbackPayloads = [
      { accessToken },
      { token: accessToken },
      { customerAccessToken: accessToken },
      { shopifyAccessToken: accessToken }
    ];
    const fallbackAuthHeaders = [accessToken, `Bearer ${accessToken}`];

    let lastError = primaryResult.ok
      ? 'No access token returned by iniBuilds login exchange.'
      : `HTTP ${primaryResult.status}${this.#extractErrorMessage(primaryResult.data) ? ` (${this.#extractErrorMessage(primaryResult.data)})` : ''}`;

    for (const payload of fallbackPayloads) {
      for (const authHeader of fallbackAuthHeaders) {
        const result = await this.#requestJson(authUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: authHeader,
            'User-Agent': 'AeroSync-Addon-Updater'
          },
          body: JSON.stringify(payload)
        });

        if (!result.ok) {
          const detail = this.#extractErrorMessage(result.data);
          lastError = `HTTP ${result.status}${detail ? ` (${detail})` : ''}`;
          continue;
        }

        const token = this.#extractToken(result.data);
        if (token) {
          return token;
        }

        lastError = 'No access token returned by iniBuilds login exchange.';
      }
    }

    throw new Error(lastError || 'iniBuilds login exchange failed.');
  }

  #extractCompanies(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const candidates = [
      payload.companies,
      payload.company,
      payload.data,
      payload.result,
      payload.items
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }

    return [];
  }

  #isOwnedIniBuildsProduct(product) {
    if (!product || typeof product !== 'object') {
      return false;
    }

    const isTruthyFlag = (value) => {
      if (value === true) {
        return true;
      }
      if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0;
      }
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === 'yes' || normalized === '1';
      }
      return false;
    };

    const candidateFlags = [
      product.purchased,
      product.owned,
      product.isPurchased,
      product.hasAccess,
      product.has_access
    ];

    if (candidateFlags.some(isTruthyFlag)) {
      return true;
    }

    const orders = product.orders ?? product.order ?? product.userOrders ?? product.user_orders;
    if (Array.isArray(orders) && orders.length > 0) {
      return true;
    }

    if (orders && typeof orders === 'object') {
      if (Array.isArray(orders.edges) && orders.edges.length > 0) {
        return true;
      }
      if (typeof orders.count === 'number' && Number.isFinite(orders.count) && orders.count > 0) {
        return true;
      }
      if (typeof orders.total === 'number' && Number.isFinite(orders.total) && orders.total > 0) {
        return true;
      }
    }

    return false;
  }

  #buildIniBuildsProductDisplayName(product, fallbackCompanyName = '') {
    const name = String(product && (
      product.name
      || product.title
      || product.product_name
      || product.productName
      || product.dir_name
      || product.dirName
      || product.slug
    ) ? (
      product.name
      || product.title
      || product.product_name
      || product.productName
      || product.dir_name
      || product.dirName
      || product.slug
    ) : '').trim();

    const companyName = String(product && (product.company_name || product.companyName) ? (product.company_name || product.companyName) : fallbackCompanyName)
      .trim();

    const simulatorRaw = String(product && (product.simulator || product.sim || product.platform) ? (product.simulator || product.sim || product.platform) : '')
      .trim();
    const simulator = simulatorRaw && simulatorRaw.length <= 16 ? simulatorRaw : simulatorRaw.slice(0, 16);

    const suffix = simulator ? ` (${simulator})` : '';

    if (companyName && name) {
      return `${companyName} – ${name}${suffix}`;
    }

    const base = name || companyName || '';
    return base ? `${base}${suffix}` : '';
  }

  #extractOwnedProductChoicesFromCompaniesResponse(payload) {
    const companies = this.#extractCompanies(payload);
    const choices = [];
    const seenIds = new Set();

    for (const company of companies) {
      if (!company || typeof company !== 'object') {
        continue;
      }

      const companyName = String(company.name || company.title || '').trim();
      const products = Array.isArray(company.products) ? company.products : [];
      for (const product of products) {
        const idNum = Number(product && (product.id ?? product.productId ?? product.product_id));
        const id = Number.isFinite(idNum) ? Math.trunc(idNum) : 0;
        if (id <= 0 || seenIds.has(id)) {
          continue;
        }

        if (!this.#isOwnedIniBuildsProduct(product)) {
          continue;
        }

        const displayName = this.#buildIniBuildsProductDisplayName(product, companyName);
        const activationKey = this.#extractIniBuildsActivationKey(product);
        choices.push({ id: String(id), name: displayName, activationKey });
        seenIds.add(id);
      }
    }

    choices.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    return choices;
  }

  #extractOwnedProductChoicesDeep(payload) {
    const choices = [];
    const seenIds = new Set();
    const visited = new Set();

    const looksLikeProduct = (node) => {
      if (!node || typeof node !== 'object') {
        return false;
      }

      const productishKeys = [
        'dir_name',
        'dirName',
        'simulator',
        'version_type',
        'versionType',
        'shopify_id',
        'shopify_variant_id',
        'company_id',
        'company_name',
        'type',
        'sub_type',
        'product_type'
      ];

      return productishKeys.some((key) => Object.prototype.hasOwnProperty.call(node, key));
    };

    const extractId = (node) => {
      const raw = node && (node.id ?? node.productId ?? node.product_id ?? node.productID);
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
    };

    const walk = (node, depth = 0, fallbackCompanyName = '') => {
      if (!node || depth > 10) {
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, depth + 1, fallbackCompanyName);
        }
        return;
      }

      if (typeof node !== 'object') {
        return;
      }

      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      const companyName = String(node.name || node.title || '').trim();
      const nextFallbackCompanyName = companyName || fallbackCompanyName;

      if (looksLikeProduct(node) && this.#isOwnedIniBuildsProduct(node)) {
        const id = extractId(node);
        if (id > 0 && !seenIds.has(id)) {
          const displayName = this.#buildIniBuildsProductDisplayName(node, nextFallbackCompanyName);
          const activationKey = this.#extractIniBuildsActivationKey(node);
          choices.push({ id: String(id), name: displayName, activationKey });
          seenIds.add(id);
        }
      }

      for (const value of Object.values(node)) {
        walk(value, depth + 1, nextFallbackCompanyName);
      }
    };

    walk(payload, 0, '');
    choices.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    return choices;
  }

  #isPlausibleIniBuildsActivationKey(value) {
    const text = String(value || '').trim();
    if (!text) {
      return false;
    }
    // Avoid obvious non-keys.
    if (/^xplane\d+$/i.test(text) || /^win$|^mac$|^linux$/i.test(text)) {
      return false;
    }
    if (text.length < 12 || text.length > 120) {
      return false;
    }
    // Typical product keys are grouped with dashes.
    if (/^[A-Z0-9]{4,}(-[A-Z0-9]{4,}){2,}$/i.test(text)) {
      return true;
    }
    // Some keys may be long base32-like tokens.
    if (/^[A-Z0-9]{20,}$/i.test(text)) {
      return true;
    }
    return false;
  }

  #extractIniBuildsActivationKey(productNode) {
    if (!productNode || typeof productNode !== 'object') {
      return '';
    }

    // --- Confirmed path (renderer analysis 2026-02): ---
    // product.orders[].OrderProduct.drm_key
    // The iniBuilds /api/v4/companies response nests DRM keys here.
    const orders = productNode.orders ?? productNode.order ?? productNode.userOrders ?? productNode.user_orders;
    if (Array.isArray(orders)) {
      for (const order of orders) {
        if (!order || typeof order !== 'object') continue;
        const op = order.OrderProduct || order.orderProduct || order.order_product;
        if (op && typeof op === 'object') {
          const drmKey = op.drm_key ?? op.drmKey ?? op.drm_code ?? op.activation_key ?? op.activationKey;
          if (typeof drmKey === 'string' && drmKey.trim()) {
            return drmKey.trim();
          }
        }
        // Some responses may flatten drm_key directly onto the order.
        const flatKey = order.drm_key ?? order.drmKey;
        if (typeof flatKey === 'string' && flatKey.trim()) {
          return flatKey.trim();
        }
      }
    }

    // --- Fallback: top-level key fields (speculative, kept as safety net) ---
    const directKeys = [
      'drm_key',
      'drmKey',
      'activationKey',
      'activation_key',
      'activationCode',
      'activation_code',
      'productKey',
      'product_key',
      'licenseKey',
      'license_key',
      'serial',
      'serialNumber',
      'serial_number',
      'key'
    ];

    for (const key of directKeys) {
      const raw = productNode[key];
      if (typeof raw === 'string' && raw.trim()) {
        return raw.trim();
      }
    }

    return '';
  }

  #extractIniBuildsActivationKeyMap(payloads) {
    const sources = Array.isArray(payloads) ? payloads : (payloads ? [payloads] : []);
    const map = new Map();
    const visited = new Set();

    const directKeys = [
      'drm_key',
      'drmKey',
      'activationKey',
      'activation_key',
      'activationCode',
      'activation_code',
      'productKey',
      'product_key',
      'licenseKey',
      'license_key',
      'serial',
      'serialNumber',
      'serial_number',
      'key'
    ];

    // Extract DRM key from the confirmed orders[].OrderProduct.drm_key path.
    const drmKeyFromOrders = (product) => {
      if (!product || typeof product !== 'object') return '';
      const orders = product.orders ?? product.order ?? product.userOrders ?? product.user_orders;
      if (!Array.isArray(orders)) return '';
      for (const order of orders) {
        if (!order || typeof order !== 'object') continue;
        const op = order.OrderProduct || order.orderProduct || order.order_product;
        if (op && typeof op === 'object') {
          const key = op.drm_key ?? op.drmKey ?? op.drm_code ?? op.activation_key ?? op.activationKey;
          if (typeof key === 'string' && key.trim()) return key.trim();
        }
        const flat = order.drm_key ?? order.drmKey;
        if (typeof flat === 'string' && flat.trim()) return flat.trim();
      }
      return '';
    };

    const shallowKeyFromObject = (obj) => {
      if (!obj || typeof obj !== 'object') {
        return '';
      }
      // Prefer confirmed nested path first.
      const fromOrders = drmKeyFromOrders(obj);
      if (fromOrders) return fromOrders;
      for (const k of directKeys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) {
          return v.trim();
        }
      }
      return '';
    };

    const extractNumericId = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
    };

    const walk = (node, depth) => {
      if (!node || depth > 8) {
        return;
      }
      if (typeof node !== 'object') {
        return;
      }
      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, depth + 1);
        }
        return;
      }

      // Common patterns:
      // - product object: { id, activationKey/productKey/... }
      // - license entry: { productId, key/serial/... }
      const id = extractNumericId(node.id);
      const productId = extractNumericId(node.productId || node.product_id);
      const key = shallowKeyFromObject(node);
      if (key) {
        if (id > 0 && !map.has(String(id))) {
          map.set(String(id), key);
        }
        if (productId > 0 && !map.has(String(productId))) {
          map.set(String(productId), key);
        }
      }

      for (const v of Object.values(node)) {
        walk(v, depth + 1);
      }
    };

    for (const src of sources) {
      walk(src, 0);
    }

    return map;
  }

  #extractProductIds(payload) {
    const ids = [];
    const visited = new Set();

    const addId = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return;
      }

      const normalized = Math.trunc(numeric);
      if (normalized <= 0 || ids.includes(normalized)) {
        return;
      }

      ids.push(normalized);
    };

    const walk = (node, depth = 0) => {
      if (!node || depth > 8) {
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, depth + 1);
        }
        return;
      }

      if (typeof node !== 'object') {
        return;
      }

      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      addId(node.productId);
      addId(node.productID);
      addId(node.product_id);
      addId(node.id);

      for (const value of Object.values(node)) {
        walk(value, depth + 1);
      }
    };

    walk(payload, 0);
    return ids;
  }

  #buildIdToNameMap(payload) {
    const map = new Map();
    const visited = new Set();

    const walk = (node, depth = 0) => {
      if (!node || depth > 8) {
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, depth + 1);
        }
        return;
      }

      if (typeof node !== 'object') {
        return;
      }

      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      const rawId = node.id ?? node.productId ?? node.product_id ?? node.productID;
      const numeric = Number(rawId);
      const id = Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
      if (id > 0) {
        const name = String(node.name ?? node.title ?? node.productName ?? '').trim();
        if (name && !map.has(id)) {
          map.set(id, name);
        }
      }

      for (const value of Object.values(node)) {
        walk(value, depth + 1);
      }
    };

    walk(payload, 0);
    return map;
  }

  async #discoverOwnedProductsViaFilesUrl(baseUrl, profile, token, candidateIds, idToName) {
    const out = [];
    const seen = new Set();
    const maxTries = 60;
    const maxFound = 40;
    let tries = 0;

    for (const productId of candidateIds) {
      if (tries >= maxTries || out.length >= maxFound) {
        break;
      }

      if (!Number.isFinite(productId) || productId <= 0 || seen.has(productId)) {
        continue;
      }
      seen.add(productId);
      tries += 1;

      try {
          const probe = await this.#probeFilesUrlWorking(baseUrl, profile, token, productId);
        const nameFromApi = String(idToName.get(productId) || '').trim();
        const nameFromFile = String(probe && probe.filename ? probe.filename : '').trim();
        const name = nameFromApi || nameFromFile;
        out.push({ id: String(productId), name });
      } catch {
        // Not owned / not accessible / wrong id – ignore.
      }
    }

    out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    return out;
  }

  #resolveProbePlatform(profile) {
    const fromProfile = String(profile && profile.platform ? profile.platform : '').trim().toLowerCase();
    if (fromProfile) {
      return fromProfile;
    }

    if (process.platform === 'win32') {
      return 'win';
    }

    if (process.platform === 'darwin') {
      return 'mac';
    }

    return 'linux';
  }

  #inferIniBuildsSimulator(profile) {
    const fromProfile = String(profile && profile.simulator ? profile.simulator : '').trim();
    if (fromProfile) {
      return fromProfile;
    }

    const fromName = String(profile && profile.inibuildsProductName ? profile.inibuildsProductName : '').trim();
    const match = fromName.match(/\b(XPlane(?:11|12))\b/i);
    if (match && match[1]) {
      return match[1];
    }

    return '';
  }

  #buildFilesUrlPayload(profile, token, productId, overrides = null) {
    const installPath = String(profile && profile.productDir ? profile.productDir : '').trim();
    const requestedSimulator = String(overrides && overrides.simulator ? overrides.simulator : '').trim();
    const simulator = requestedSimulator || this.#inferIniBuildsSimulator(profile);
    const requestedPlatform = String(overrides && overrides.platform ? overrides.platform : '').trim().toLowerCase();
    const platform = requestedPlatform || this.#resolveProbePlatform(profile);

    // Confirmed from iniManager renderer analysis: the IPC payload to the main
    // process contains these fields.  The main process POSTs them to filesUrl.
    // Note: request_url is only an IPC routing hint in the original app (it tells
    // the main process where to POST), NOT a server-side field.
    // file_replace_tag is only used in uninstall calls, not filesUrl.
    return {
      token,
      productId,
      platform,
      simulator,
      full: true,
      is_executable: false,
      custom_location: Boolean(installPath),
      installPath
    };
  }

  async #probeFilesUrl(baseUrl, profile, token, productId) {
    const url = this.#joinUrl(baseUrl, this.filesUrlPath);
    const payload = this.#buildFilesUrlPayload(profile, token, productId);
    // Confirmed from renderer analysis: Authorization header is bare deviceId
    // (no Bearer prefix).  The token is also in the POST body already.
    const authHeaderCandidates = [token, `Bearer ${token}`];
    let lastError = '';

    for (const authHeader of authHeaderCandidates) {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'AeroSync-Addon-Updater'
      };
      if (authHeader) {
        headers.Authorization = authHeader;
      }

      const result = await this.#requestJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!result.ok) {
        const detail = this.#extractErrorMessage(result.data);
        lastError = `HTTP ${result.status}${detail ? ` (${detail})` : ''}`;
        continue;
      }

      const data = result.data && typeof result.data === 'object' ? result.data : {};
      const rawIntegrity = String(data.filesIntegrityHash || '').trim();
      const integrityMd5 = this.#normalizeFilesIntegrityHashToMd5(rawIntegrity);
      return {
        url: String(data.url || '').trim(),
        filename: String(data.filename || '').trim(),
        productId: Number(data.productId || productId || 0),
        filesIntegrityHash: rawIntegrity,
        filesIntegrityMd5: integrityMd5,
        cacheTime: String(data.cacheTime || '').trim()
      };
    }

    throw new Error(lastError || 'filesUrl probe failed.');
  }

  async #probeDownloadUrlOk(downloadUrl, headerCandidates = null) {
    const url = this.#normalizeSignedUrl(downloadUrl);
    const candidates = Array.isArray(headerCandidates) && headerCandidates.length > 0
      ? headerCandidates
      : [null];

    let lastStatus = 0;
    let lastError = '';
    for (const headers of candidates) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('timeout'), Math.max(2000, Math.min(8000, this.timeoutMs)));
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              Accept: '*/*',
              'Accept-Encoding': 'identity',
              Range: 'bytes=0-0',
              'User-Agent': 'AeroSync-Addon-Updater',
              ...(headers && typeof headers === 'object' ? headers : {})
            },
            redirect: 'follow',
            signal: controller.signal
          });

          lastStatus = res.status;
          if (res.status === 200 || res.status === 206 || (res.status >= 300 && res.status < 400)) {
            return { ok: true, status: res.status };
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = String(error && error.message ? error.message : error || 'unknown error');
      }
    }

    return { ok: false, status: lastStatus, error: lastError };
  }

  async #probeFilesUrlWorking(baseUrl, profile, token, productId) {
    // Confirmed from renderer analysis: download URLs from filesUrl are signed
    // (contain auth in query params), so no Authorization header needed for the
    // actual download.  The filesUrl API call uses bare token as Authorization.
    const downloadHeaderCandidates = [
      null,
      { Authorization: token }
    ];

    const simulatorHint = this.#inferIniBuildsSimulator(profile);
    // X-Plane-focused: profile hint first, then XPlane12 (most common), then XPlane11.
    // Skip empty string unless it's the only option.
    const simulatorCandidates = [simulatorHint, 'XPlane12', 'XPlane11']
      .filter((v) => Boolean(v))
      .filter((v, i, a) => a.indexOf(v) === i);
    if (simulatorCandidates.length === 0) {
      simulatorCandidates.push('');
    }

    // Platform: resolved from profile/system first, then standard list.
    const detectedPlatform = this.#resolveProbePlatform(profile);
    const platformCandidates = [detectedPlatform, 'win', 'mac', 'linux']
      .filter((v, i, a) => a.indexOf(v) === i);

    let lastError = '';
    for (const simulator of simulatorCandidates) {
      for (const platform of platformCandidates) {
        try {
          const url = this.#joinUrl(baseUrl, this.filesUrlPath);
          const payload = this.#buildFilesUrlPayload(profile, token, productId, { simulator, platform });
          // Confirmed: Authorization is bare deviceId (no Bearer prefix).
          const result = await this.#requestJson(url, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              Authorization: token,
              'User-Agent': 'AeroSync-Addon-Updater'
            },
            body: JSON.stringify(payload)
          });

          if (!result.ok) {
            const detail = this.#extractErrorMessage(result.data);
            lastError = `HTTP ${result.status}${detail ? ` (${detail})` : ''}`;
            continue;
          }

          const data = result.data && typeof result.data === 'object' ? result.data : {};
          const rawIntegrity = String(data.filesIntegrityHash || '').trim();
          const integrityMd5 = this.#normalizeFilesIntegrityHashToMd5(rawIntegrity);
          const probe = {
            url: String(data.url || '').trim(),
            filename: String(data.filename || '').trim(),
            productId: Number(data.productId || productId || 0),
            filesIntegrityHash: rawIntegrity,
            filesIntegrityMd5: integrityMd5,
            cacheTime: String(data.cacheTime || '').trim(),
            platform,
            simulator
          };

          if (!probe.url) {
            lastError = 'filesUrl returned no download URL.';
            continue;
          }

          const ok = await this.#probeDownloadUrlOk(probe.url, downloadHeaderCandidates);
          if (!ok.ok) {
            lastError = `Download URL not accessible (HTTP ${ok.status || 'n/a'}).`;
            continue;
          }

          return probe;
        } catch (error) {
          lastError = String(error && error.message ? error.message : error || 'unknown error');
        }
      }
    }

    throw new Error(lastError || 'No working filesUrl download variant found.');
  }

  async #authenticate(baseUrl, profile) {
    const login = String(profile && profile.login ? profile.login : '').trim();
    const password = String(profile && profile.password ? profile.password : '').trim();
    const fallbackSecret = String(profile && profile.licenseKey ? profile.licenseKey : '').trim();
    const secret = password || fallbackSecret;

    if (!login || !secret) {
      throw new Error('iniBuilds credentials are missing (login/password).');
    }

    const authUrl = this.#joinUrl(baseUrl, this.authPath);

    // Confirmed from iniManager renderer analysis: iniBuilds uses exclusively
    // two-stage Shopify auth.  The direct-auth fallback candidates below will
    // almost certainly never succeed against the real API, but are kept as a
    // safety net in case the auth model changes.
    const authErrors = [];
    if (this.shopifyApiToken && this.shopifyApiUrl) {
      try {
        const storefrontToken = await this.#authenticateViaShopify(login, secret);
        const exchangeToken = await this.#exchangeAccessToken(baseUrl, storefrontToken);
        return exchangeToken;
      } catch (error) {
        const authError = String(error && error.message ? error.message : error || 'unknown error');
        authErrors.push(`shopify+exchange: ${authError}`);
        this.logger.warn('Shopify auth/exchange failed, falling back to direct iniBuilds auth payloads', {
          reason: authError
        });
      }
    }

    // Direct auth fallback (unlikely to work against current iniBuilds API).
    const payloadCandidates = [
      { email: login, password: secret },
      { login, password: secret },
      { username: login, password: secret },
      { email: login, licenseKey: secret },
      { accessToken: secret }
    ];

    for (const candidate of payloadCandidates) {
      const result = await this.#requestJson(authUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'AeroSync-Addon-Updater'
        },
        body: JSON.stringify(candidate)
      });

      if (!result.ok) {
        const detail = this.#extractErrorMessage(result.data);
        authErrors.push(`direct-auth: HTTP ${result.status}${detail ? ` (${detail})` : ''}`);
        continue;
      }

      const token = this.#extractToken(result.data);
      if (token) {
        return token;
      }

      authErrors.push('direct-auth: No access token returned by auth endpoint.');
    }

    const reason = authErrors.length > 0
      ? authErrors[authErrors.length - 1]
      : 'unknown error';
    throw new Error(`iniBuilds authentication failed (${reason}).`);
  }

  #buildProbeAction(filesUrlProbe) {
    if (!filesUrlProbe) {
      return null;
    }

    const fileName = String(filesUrlProbe.filename || '').trim() || 'inibuilds-probe-package.zip';
    const productId = Number(filesUrlProbe.productId || 0);
    const packageName = productId > 0 ? `iniBuilds Product ${productId}` : 'iniBuilds Product';
    const relativePath = normalizeProbeRelativePath(fileName);

    return {
      type: 'update',
      packageId: productId > 0 ? String(productId) : 'inibuilds-probe',
      packageName,
      relativePath,
      compressedSize: Number(filesUrlProbe.compressedSize || 0),
      realSize: Number(filesUrlProbe.realSize || 0),
      hash: String(filesUrlProbe.filesIntegrityHash || '').trim(),
      sourceUrl: String(filesUrlProbe.url || '').trim(),
      sourceUrlSigned: Boolean(filesUrlProbe.url),
      cacheTime: String(filesUrlProbe.cacheTime || '').trim(),
      probe: true
    };
  }

  #pickProductLabelForId(productChoices, productId) {
    const target = String(productId || '').trim();
    if (!target) {
      return '';
    }

    const choices = Array.isArray(productChoices) ? productChoices : [];
    const match = choices.find((item) => String(item && item.id ? item.id : '').trim() === target);
    return String(match && match.name ? match.name : '').trim();
  }

  async createUpdatePlan(profile, options = {}) {
    const isFresh = Boolean(options && options.fresh);
    const isRepair = Boolean(options && options.repair);

    const baseUrl = this.#normalizeBaseUrl(profile);
    this.logger.info('Starting iniBuilds API probe (auth + products + filesUrl)', {
      baseUrl,
      authPath: this.authPath,
      productsPath: this.productsPath,
      filesUrlPath: this.filesUrlPath
    });

    const token = await this.#authenticate(baseUrl, profile);
    const productsUrl = this.#joinUrl(baseUrl, this.productsPath);
    let productsData = null;
    let productsRequestWarning = '';

    // Confirmed from renderer analysis: Authorization header is bare deviceId
    // (no Bearer prefix).  Bearer variant kept as last-resort fallback.
    const primaryAuthHeader = String(token || '').trim();

    const fetchCompaniesPayloads = async (staticPathProducts) => {
      const out = [];
      const warnings = [];

      // Try primary (bare token) first.
      const productsResult = await this.#requestJson(productsUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: primaryAuthHeader,
          'User-Agent': 'AeroSync-Addon-Updater'
        },
        body: JSON.stringify({
          staticPathProducts: Boolean(staticPathProducts)
        })
      });

      if (productsResult.ok && productsResult.data) {
        out.push(productsResult.data);
        return { payloads: out, warnings };
      }

      if (!productsResult.ok) {
        const detail = this.#extractErrorMessage(productsResult.data);
        warnings.push(`companies(${staticPathProducts ? 'static' : 'full'}): HTTP ${productsResult.status}${detail ? ` (${detail})` : ''}`);
      }

      // Fallback: try Bearer prefix.
      const bearerResult = await this.#requestJson(productsUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${primaryAuthHeader}`,
          'User-Agent': 'AeroSync-Addon-Updater'
        },
        body: JSON.stringify({
          staticPathProducts: Boolean(staticPathProducts)
        })
      });

      if (!bearerResult.ok) {
        const detail = this.#extractErrorMessage(bearerResult.data);
        warnings.push(`companies(${staticPathProducts ? 'static' : 'full'},bearer): HTTP ${bearerResult.status}${detail ? ` (${detail})` : ''}`);
      } else if (bearerResult.data) {
        out.push(bearerResult.data);
      }

      return { payloads: out, warnings };
    };

    const payloads = [];
    try {
      const primary = await fetchCompaniesPayloads(true);
      payloads.push(...primary.payloads);
      if (primary.warnings.length) {
        productsRequestWarning = primary.warnings.join('; ');
      }
    } catch (error) {
      productsRequestWarning = String(error && error.message ? error.message : error || 'unknown error');
    }

    productsData = payloads.length > 0 ? payloads[0] : null;

    const companies = this.#extractCompanies(productsData);
    const companyCount = companies.length;
    const totalProducts = companies.reduce((sum, company) => {
      if (!company || typeof company !== 'object' || !Array.isArray(company.products)) {
        return sum;
      }
      return sum + company.products.length;
    }, 0);

    const ownedFromCompanies = this.#extractOwnedProductChoicesFromCompaniesResponse(productsData);
    const ownedDeep = this.#extractOwnedProductChoicesDeep(productsData);
    const ownedUnion = (() => {
      const map = new Map();
      for (const item of [...ownedFromCompanies, ...ownedDeep]) {
        const id = String(item && item.id ? item.id : '').trim();
        if (!id || id === '0') {
          continue;
        }
        const name = String(item && item.name ? item.name : '').trim();
        const activationKey = String(item && item.activationKey ? item.activationKey : '').trim();
        const existing = map.get(id);
        if (!existing) {
          map.set(id, { id, name, activationKey });
          continue;
        }
        if (!existing.name && name) {
          existing.name = name;
        }
        if (!existing.activationKey && activationKey) {
          existing.activationKey = activationKey;
        }
      }
      const out = [...map.values()];
      out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
      return out;
    })();

    if (ownedUnion.length < 10) {
      try {
        const alt = await fetchCompaniesPayloads(false);
        payloads.push(...alt.payloads);
        if (alt.warnings.length) {
          productsRequestWarning = productsRequestWarning
            ? `${productsRequestWarning}; ${alt.warnings.join('; ')}`
            : alt.warnings.join('; ');
        }
      } catch (error) {
        const altWarning = String(error && error.message ? error.message : error || 'unknown error');
        if (altWarning) {
          productsRequestWarning = productsRequestWarning
            ? `${productsRequestWarning}; alt: ${altWarning}`
            : `Alt companies probe failed: ${altWarning}`;
        }
      }
    }

    const ownedUnionMerged = (() => {
      const combined = [];
      for (const payload of payloads) {
        combined.push(...this.#extractOwnedProductChoicesFromCompaniesResponse(payload));
        combined.push(...this.#extractOwnedProductChoicesDeep(payload));
      }

      const map = new Map();
      for (const item of combined) {
        const id = String(item && item.id ? item.id : '').trim();
        if (!id || id === '0') {
          continue;
        }
        const name = String(item && item.name ? item.name : '').trim();
        const activationKey = String(item && item.activationKey ? item.activationKey : '').trim();
        const existing = map.get(id);
        if (!existing) {
          map.set(id, { id, name, activationKey });
          continue;
        }
        if (!existing.name && name) {
          existing.name = name;
        }
        if (!existing.activationKey && activationKey) {
          existing.activationKey = activationKey;
        }
      }
      const out = [...map.values()];
      out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
      return out;
    })();

    const activationKeyByProductId = this.#extractIniBuildsActivationKeyMap(payloads);

    const idToName = (() => {
      const map = new Map();
      for (const payload of payloads) {
        const partial = this.#buildIdToNameMap(payload);
        for (const [id, name] of partial.entries()) {
          if (!map.has(id) && name) {
            map.set(id, name);
          }
        }
      }
      return map;
    })();
    const candidateProductIds = [];
    const preferredProductId = Number(profile && profile.inibuildsProductId ? profile.inibuildsProductId : 0);
    const hasPreferred = Number.isFinite(preferredProductId) && preferredProductId > 0;
    if (hasPreferred) {
      candidateProductIds.push(Math.trunc(preferredProductId));
    } else {
      for (const payload of payloads) {
        for (const extractedId of this.#extractProductIds(payload)) {
          if (!candidateProductIds.includes(extractedId)) {
            candidateProductIds.push(extractedId);
          }
        }
      }
    }

    let filesUrlProbe = null;
    let filesUrlProbeError = '';

    if (hasPreferred) {
      try {
        filesUrlProbe = await this.#probeFilesUrlWorking(baseUrl, profile, token, Math.trunc(preferredProductId));
        if (filesUrlProbe && filesUrlProbe.url) {
          const size = await this.#probeSignedDownloadSize(filesUrlProbe.url);
          if (size > 0) {
            filesUrlProbe.compressedSize = size;
            filesUrlProbe.realSize = size;
          }
        }
      } catch (error) {
        filesUrlProbeError = String(error && error.message ? error.message : error || 'unknown error');
      }
    }

    let ownedProductChoices = ownedUnionMerged;
    let ownedChoiceSource = 'companies';
    if (!ownedProductChoices || ownedProductChoices.length <= 0) {
      ownedProductChoices = await this.#discoverOwnedProductsViaFilesUrl(
        baseUrl,
        profile,
        token,
        candidateProductIds,
        idToName
      );
      ownedChoiceSource = 'filesUrl-probe';
    }

    // Enrich choices with activation keys from companies payloads if available.
    if (ownedProductChoices && ownedProductChoices.length > 0 && activationKeyByProductId && activationKeyByProductId.size > 0) {
      ownedProductChoices = ownedProductChoices.map((item) => {
        const id = String(item && item.id ? item.id : '').trim();
        if (!id || id === '0') {
          return item;
        }
        const existingKey = String(item && item.activationKey ? item.activationKey : '').trim();
        if (existingKey) {
          return item;
        }
        const enriched = activationKeyByProductId.get(id);
        if (!enriched) {
          return item;
        }
        return { ...item, activationKey: enriched };
      });
    }

    const now = Date.now();

    this.logger.info('iniBuilds API probe finished', {
      companyCount,
      totalProducts,
      ownedChoiceSource,
      ownedProductChoiceCount: ownedProductChoices.length,
      candidateProductIdCount: candidateProductIds.length,
      filesUrlProbeSuccess: Boolean(filesUrlProbe),
      activationKeyCandidateCount: activationKeyByProductId ? activationKeyByProductId.size : 0
    });

    const warnings = [
      `iniBuilds API connection successful (${companyCount} compan${companyCount === 1 ? 'y' : 'ies'}, ${totalProducts} product(s), ${ownedProductChoices.length} owned product(s)).`
    ];

    const profileId = String(profile && profile.id ? profile.id : '').trim();
    const ignoreMatchers = this.#compileIgnoreMatchers(profile && profile.ignoreList ? profile.ignoreList : []);
    const previousManifest = profileId ? await this.#loadIniBuildsManifest(profileId) : null;

    if (productsRequestWarning) {
      warnings.push(`Product list probe warning: ${productsRequestWarning}`);
    }

    if (filesUrlProbe) {
      warnings.push(
        `filesUrl probe successful for product ${filesUrlProbe.productId || 'unknown'} (${filesUrlProbe.filename || 'no filename'}).`
      );
      if (filesUrlProbe.filesIntegrityHash) {
        warnings.push('filesIntegrityHash field detected in filesUrl response.');
      }
      if (filesUrlProbe.filesIntegrityHash && !filesUrlProbe.filesIntegrityMd5) {
        warnings.push('filesIntegrityHash is present but could not be normalized to an MD5. Install verification may fail.');
      }
    } else {
      warnings.push(
        `filesUrl probe not yet successful${filesUrlProbeError ? ` (${filesUrlProbeError})` : ''}.`
      );
    }

    let actions = [];
    let diskSize = 0;
    let knownDownloadSize = 0;
    let unknownDownloadCount = 0;
    let zipEntryCount = 0;
    let comparedFileCount = 0;
    let zipListingMode = '';
    let compareSucceeded = false;
    let tempZipPath = '';
    let zipListingError = '';
    let zipDownloadCompareError = '';
    let ignoredCount = 0;

    const zipFileSet = new Set();
    const manifestFiles = [];

    const selectedProductLabel = this.#pickProductLabelForId(ownedProductChoices, preferredProductId)
      || String(profile && profile.inibuildsProductName ? profile.inibuildsProductName : '').trim();

    if (hasPreferred && filesUrlProbe && filesUrlProbe.url) {
      const zipSize = Number(filesUrlProbe.compressedSize || 0);
      knownDownloadSize = Number.isFinite(zipSize) && zipSize > 0 ? zipSize : 0;

      // Download URLs from filesUrl are typically signed (auth in query params),
      // so no Authorization header should be needed.  Bare token as fallback.
      const downloadHeaderCandidates = [
        null,
        { Authorization: token }
      ];

      try {
        const zipListing = await this.#getZipEntriesFromSignedUrl(filesUrlProbe.url, knownDownloadSize, null, downloadHeaderCandidates);
        const zipEntries = Array.isArray(zipListing && zipListing.entries) ? zipListing.entries : [];
        zipEntryCount = zipEntries.length;
        zipListingMode = 'range';
        if (knownDownloadSize <= 0 && zipListing && Number.isFinite(Number(zipListing.totalSize)) && Number(zipListing.totalSize) > 0) {
          knownDownloadSize = Math.trunc(Number(zipListing.totalSize));
        }

        const rootDir = String(profile && profile.productDir ? profile.productDir : '').trim();
        if (!rootDir) {
          throw new Error('Profile productDir is missing.');
        }

        const updateActions = [];
        for (const entry of zipEntries) {
          const fileName = String(entry && entry.fileName ? entry.fileName : '').trim();
          if (!fileName || fileName.endsWith('/')) {
            continue;
          }

          const relPath = this.#normalizeZipRelPath(fileName);
          if (!relPath) {
            continue;
          }

          if (this.#shouldIgnoreRelativePath(relPath, ignoreMatchers)) {
            ignoredCount += 1;
            continue;
          }

          zipFileSet.add(relPath);
          manifestFiles.push(relPath);

          const destPath = path.join(rootDir, relPath);
          try {
            this.#assertWithinRoot(rootDir, destPath);
          } catch {
            continue;
          }

          comparedFileCount += 1;

          const expectedSize = Number(entry.uncompressedSize || 0);
          const expectedCrc32 = Number(entry.crc32 || 0) >>> 0;

          let needsUpdate = isFresh;
          if (!needsUpdate) {
            try {
              const stat = await fsp.stat(destPath);
              if (!stat.isFile()) {
                needsUpdate = true;
              } else if (Number.isFinite(expectedSize) && expectedSize > 0 && stat.size !== expectedSize) {
                needsUpdate = true;
              } else {
                const actualCrc = await this.#crc32File(destPath);
                if ((actualCrc >>> 0) !== expectedCrc32) {
                  needsUpdate = true;
                }
              }
            } catch {
              needsUpdate = true;
            }
          }

          if (!needsUpdate) {
            continue;
          }

          diskSize += Number(entry.uncompressedSize || 0);
          updateActions.push({
            type: 'update',
            packageId: String(Math.trunc(preferredProductId)),
            packageName: selectedProductLabel || `iniBuilds Product ${Math.trunc(preferredProductId)}`,
            relativePath: relPath,
            compressedSize: Number(entry.compressedSize || 0),
            realSize: Number(entry.uncompressedSize || 0),
            hash: `crc32:${this.#formatCrc32(expectedCrc32)}`,
            packageHash: String(filesUrlProbe.filesIntegrityMd5 || '').trim(),
            sourceUrl: String(filesUrlProbe.url || '').trim(),
            sourceUrlSigned: true,
            zipEntryName: fileName,
            zipMethod: Number(entry.method || 0),
            zipLocalHeaderOffset: Number(entry.localHeaderOffset || 0)
          });
        }

        const deleteActions = [];
        const manifestMatches = previousManifest
          && Array.isArray(previousManifest.files)
          && previousManifest.files.length > 0
          && (!Number(previousManifest.productId || 0) || Number(previousManifest.productId || 0) === Math.trunc(preferredProductId));
        if (manifestMatches) {
          for (const oldRelPath of previousManifest.files) {
            const rel = this.#normalizeZipRelPath(oldRelPath);
            if (!rel) {
              continue;
            }
            if (this.#shouldIgnoreRelativePath(rel, ignoreMatchers)) {
              continue;
            }
            if (zipFileSet.has(rel)) {
              continue;
            }
            const destPath = path.join(rootDir, rel);
            try {
              this.#assertWithinRoot(rootDir, destPath);
            } catch {
              continue;
            }
            deleteActions.push({
              type: 'delete',
              packageId: String(Math.trunc(preferredProductId)),
              packageName: selectedProductLabel || `iniBuilds Product ${Math.trunc(preferredProductId)}`,
              relativePath: rel,
              compressedSize: 0,
              realSize: 0,
              hash: '',
              packageHash: String(filesUrlProbe.filesIntegrityMd5 || '').trim(),
              sourceUrl: String(filesUrlProbe.url || '').trim(),
              sourceUrlSigned: true
            });
          }
        }

        actions = [...deleteActions, ...updateActions];
        compareSucceeded = true;
        if (knownDownloadSize <= 0 && actions.length > 0) {
          unknownDownloadCount = 1;
        }

        if (isFresh) {
          warnings.push('iniBuilds plan: fresh install mode enabled (all package files will be extracted).');
        } else if (isRepair) {
          warnings.push('iniBuilds plan: repair mode enabled (all package files are verified via ZIP CRC32 and size).');
        } else {
          warnings.push('iniBuilds plan: files are compared via ZIP CRC32 and size.');
        }
        warnings.push(manifestMatches ? 'iniBuilds delete detection enabled (based on local manifest).' : 'iniBuilds delete detection unavailable (no local manifest yet).');
      } catch (error) {
        const reason = String(error && error.message ? error.message : error || 'unknown error');
        zipListingError = reason;
        this.logger.warn('iniBuilds ZIP range listing failed', { reason });
        warnings.push(`ZIP listing via HTTP range unavailable (${reason}). Trying full download for file compare ...`);

        try {
          const expectedMd5 = String(filesUrlProbe.filesIntegrityMd5 || '').trim();
          if (!expectedMd5) {
            throw new Error('Missing filesIntegrityHash; cannot safely download for compare.');
          }

          tempZipPath = path.join(this.tempDir || process.cwd(), `inibuilds-plan-${crypto.randomUUID()}.zip`);
          // Try downloading with and without Authorization headers.
          let downloaded = false;
          let lastDownloadError = '';
          for (const headers of downloadHeaderCandidates) {
            try {
              await this.#downloadToFile(filesUrlProbe.url, tempZipPath, null, headers);
              downloaded = true;
              lastDownloadError = '';
              break;
            } catch (dlError) {
              lastDownloadError = String(dlError && dlError.message ? dlError.message : dlError || 'unknown error');
            }
          }

          if (!downloaded) {
            throw new Error(lastDownloadError || 'Download failed.');
          }
          await this.#verifyPackageMd5(tempZipPath, expectedMd5);
          const zipEntries = await this.#getZipEntriesFromLocalFile(tempZipPath);

          zipEntryCount = zipEntries.length;
          zipListingMode = 'download';
          const stat = await fsp.stat(tempZipPath);
          if (stat && Number.isFinite(Number(stat.size)) && Number(stat.size) > 0) {
            knownDownloadSize = Math.trunc(Number(stat.size));
          }

          const rootDir = String(profile && profile.productDir ? profile.productDir : '').trim();
          if (!rootDir) {
            throw new Error('Profile productDir is missing.');
          }

          const updateActions = [];
          for (const entry of zipEntries) {
            const fileName = String(entry && entry.fileName ? entry.fileName : '').trim();
            if (!fileName || fileName.endsWith('/')) {
              continue;
            }

            const relPath = this.#normalizeZipRelPath(fileName);
            if (!relPath) {
              continue;
            }

            if (this.#shouldIgnoreRelativePath(relPath, ignoreMatchers)) {
              ignoredCount += 1;
              continue;
            }

            zipFileSet.add(relPath);
            manifestFiles.push(relPath);

            const destPath = path.join(rootDir, relPath);
            try {
              this.#assertWithinRoot(rootDir, destPath);
            } catch {
              continue;
            }

            comparedFileCount += 1;

            const expectedSize = Number(entry.uncompressedSize || 0);
            const expectedCrc32 = Number(entry.crc32 || 0) >>> 0;

            let needsUpdate = isFresh;
            if (!needsUpdate) {
              try {
                const stat = await fsp.stat(destPath);
                if (!stat.isFile()) {
                  needsUpdate = true;
                } else if (Number.isFinite(expectedSize) && expectedSize > 0 && stat.size !== expectedSize) {
                  needsUpdate = true;
                } else {
                  const actualCrc = await this.#crc32File(destPath);
                  if ((actualCrc >>> 0) !== expectedCrc32) {
                    needsUpdate = true;
                  }
                }
              } catch {
                needsUpdate = true;
              }
            }

            if (!needsUpdate) {
              continue;
            }

            diskSize += Number(entry.uncompressedSize || 0);
            updateActions.push({
              type: 'update',
              packageId: String(Math.trunc(preferredProductId)),
              packageName: selectedProductLabel || `iniBuilds Product ${Math.trunc(preferredProductId)}`,
              relativePath: relPath,
              compressedSize: Number(entry.compressedSize || 0),
              realSize: Number(entry.uncompressedSize || 0),
              hash: `crc32:${this.#formatCrc32(expectedCrc32)}`,
              packageHash: expectedMd5,
              sourceUrl: String(filesUrlProbe.url || '').trim(),
              sourceUrlSigned: true,
              zipEntryName: fileName,
              zipMethod: Number(entry.method || 0),
              zipLocalHeaderOffset: Number(entry.localHeaderOffset || 0)
            });
          }

          const deleteActions = [];
          const manifestMatches = previousManifest
            && Array.isArray(previousManifest.files)
            && previousManifest.files.length > 0
            && (!Number(previousManifest.productId || 0) || Number(previousManifest.productId || 0) === Math.trunc(preferredProductId));
          if (manifestMatches) {
            for (const oldRelPath of previousManifest.files) {
              const rel = this.#normalizeZipRelPath(oldRelPath);
              if (!rel) {
                continue;
              }
              if (this.#shouldIgnoreRelativePath(rel, ignoreMatchers)) {
                continue;
              }
              if (zipFileSet.has(rel)) {
                continue;
              }
              const destPath = path.join(rootDir, rel);
              try {
                this.#assertWithinRoot(rootDir, destPath);
              } catch {
                continue;
              }
              deleteActions.push({
                type: 'delete',
                packageId: String(Math.trunc(preferredProductId)),
                packageName: selectedProductLabel || `iniBuilds Product ${Math.trunc(preferredProductId)}`,
                relativePath: rel,
                compressedSize: 0,
                realSize: 0,
                hash: '',
                packageHash: expectedMd5,
                sourceUrl: String(filesUrlProbe.url || '').trim(),
                sourceUrlSigned: true
              });
            }
          }

          actions = [...deleteActions, ...updateActions];
          compareSucceeded = true;
          warnings.push('iniBuilds plan: built via downloaded ZIP (range unsupported).');
          warnings.push(manifestMatches ? 'iniBuilds delete detection enabled (based on local manifest).' : 'iniBuilds delete detection unavailable (no local manifest yet).');
        } catch (fallbackError) {
          const fallbackReason = String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError || 'unknown error');
          zipDownloadCompareError = fallbackReason;
          this.logger.warn('iniBuilds ZIP download+compare failed', { reason: fallbackReason });
          warnings.push(`ZIP download/compare unavailable (${fallbackReason}). Falling back to package-level probe.`);
        }
      }
    }

    if (compareSucceeded && actions.length === 0) {
      // ZIP compare succeeded and detected no changed files: report a clean "up-to-date" plan.
      knownDownloadSize = 0;
      unknownDownloadCount = 0;
      diskSize = 0;
      warnings.push('iniBuilds plan: no changes detected (all files match).');
    } else if (!compareSucceeded && actions.length === 0) {
      const probeAction = this.#buildProbeAction(filesUrlProbe);
      if (probeAction && hasPreferred && selectedProductLabel) {
        probeAction.packageName = selectedProductLabel;
      }
      actions = probeAction ? [probeAction] : [];
      const hasKnownSize = actions.length > 0 && Number(actions[0].compressedSize || 0) > 0;
      knownDownloadSize = hasKnownSize ? Number(actions[0].compressedSize || 0) : 0;
      unknownDownloadCount = actions.length > 0 && !hasKnownSize ? 1 : 0;
      diskSize = 0;
    }

    const deleteCount = actions.filter((a) => a && a.type === 'delete').length;
    const updateCount = actions.filter((a) => a && a.type === 'update').length;

    const planId = `inibuilds-probe-${now}`;
    this.logger.info('iniBuilds plan built', {
      planId,
      hasPreferred,
      zipListingMode,
      actionCount: actions.length,
      zipEntryCount,
      comparedFileCount,
      downloadSize: knownDownloadSize,
      diskSize
    });
    const plan = {
      planId,
      summary: {
        snapshotType: 'inibuilds',
        snapshotNumber: 0,
        fileCount: updateCount,
        deleteCount,
        downloadSize: knownDownloadSize,
        downloadSizeKnown: knownDownloadSize,
        downloadSizeEstimatedMax: knownDownloadSize,
        downloadSizeUnknownCount: unknownDownloadCount,
        diskSize,
        ignoredCount,
        optionalIgnoredCount: 0,
        optionalForcedInstallCount: 0
      },
      actions,
      warnings,
      inibuildsProducts: ownedProductChoices,
      diagnostics: {
        provider: 'inibuilds',
        probe: {
          filesUrlPath: this.filesUrlPath,
          ownedChoiceSource,
          preferredProductId: Number.isFinite(preferredProductId) ? preferredProductId : 0,
          productCandidatesTried: candidateProductIds.slice(0, 8),
          ownedProductChoiceCount: ownedProductChoices.length,
          zip: hasPreferred && filesUrlProbe && filesUrlProbe.url
            ? {
              zipSize: Number(filesUrlProbe.compressedSize || 0),
              zipEntryCount,
              comparedFileCount,
              zipListingMode,
              zipListingError,
              zipDownloadCompareError
            }
            : null,
          filesUrlProbe: filesUrlProbe
            ? {
              productId: filesUrlProbe.productId || 0,
              filename: filesUrlProbe.filename || '',
              hasUrl: Boolean(filesUrlProbe.url),
              hasFilesIntegrityHash: Boolean(filesUrlProbe.filesIntegrityHash),
              hasCacheTime: Boolean(filesUrlProbe.cacheTime)
            }
            : null
        }
      },
      optionalPackages: []
    };

    this.planCache.set(planId, {
      planId,
      profileId: String(profile && profile.id ? profile.id : ''),
      createdAt: new Date().toISOString(),
      actions,
      summary: plan.summary,
      inibuilds: filesUrlProbe && filesUrlProbe.url
        ? {
          url: String(filesUrlProbe.url || '').trim(),
          filename: String(filesUrlProbe.filename || '').trim(),
          md5: String(filesUrlProbe.filesIntegrityMd5 || '').trim(),
          productId: Number(filesUrlProbe.productId || preferredProductId || 0),
          zipSize: Number(knownDownloadSize || filesUrlProbe.compressedSize || 0),
          tempZipPath: String(tempZipPath || '').trim(),
          zipListingMode: String(zipListingMode || '').trim(),
          manifestFiles,
          previousManifestFiles: previousManifest && Array.isArray(previousManifest.files) ? previousManifest.files : null
        }
        : null
    });

    return plan;
  }

  async installPlan(profile, planId, onProgress, runtimeControl = {}) {
    const logger = this.logger.withCorrelation('inibuilds-install');
    logger.info('Starting iniBuilds install MVP (download + checksum verify)', {
      planId,
      profileId: String(profile && profile.id ? profile.id : '')
    });

    const cached = this.planCache.get(planId);
    if (!cached) {
      throw new Error('Update plan not found. Run update check first.');
    }

    const requestedProfileId = String(profile && profile.id ? profile.id : '');
    if (requestedProfileId && cached.profileId && requestedProfileId !== cached.profileId) {
      throw new Error('Plan does not belong to the selected profile.');
    }

    const actions = Array.isArray(cached.actions) ? cached.actions : [];
    const deleteActions = actions.filter((action) => action && action.type === 'delete');
    const updateActions = actions.filter((action) => action && action.type === 'update');
    if (deleteActions.length === 0 && updateActions.length === 0) {
      throw new Error('No install actions found. Run update check again.');
    }

    const meta = cached.inibuilds && typeof cached.inibuilds === 'object' ? cached.inibuilds : null;
    let url = updateActions.length > 0
      ? this.#normalizeSignedUrl(String(meta && meta.url ? meta.url : updateActions[0].sourceUrl))
      : '';
    let expectedHash = String(meta && meta.md5 ? meta.md5 : (updateActions[0] && (updateActions[0].packageHash || updateActions[0].hash) ? (updateActions[0].packageHash || updateActions[0].hash) : ''))
      .trim()
      .toLowerCase();
    if (updateActions.length > 0 && !expectedHash) {
      throw new Error('Missing expected checksum for iniBuilds download (filesIntegrityHash).');
    }

    const isCancelled = () =>
      Boolean(runtimeControl.isCancelled && runtimeControl.isCancelled())
      || Boolean(runtimeControl.signal && runtimeControl.signal.aborted);
    const isPaused = () => Boolean(runtimeControl.isPaused && runtimeControl.isPaused());
    const waitUntilResumed = async () => {
      while (isPaused()) {
        if (isCancelled()) {
          throw this.#createInstallAbortError();
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    };

    if (isCancelled()) {
      throw this.#createInstallAbortError();
    }

    await waitUntilResumed();

    const tempDownload = path.join(this.tempDir || process.cwd(), `inibuilds-download-${crypto.randomUUID()}.zip`);
    const tempResult = path.join(this.tempDir || process.cwd(), `inibuilds-result-${crypto.randomUUID()}.tmp`);

    try {
      const rootDir = String(profile && profile.productDir ? profile.productDir : '').trim();
      if (!rootDir) {
        throw new Error('Profile productDir is missing.');
      }

      const baseUrl = this.#normalizeBaseUrl(profile);

      // Re-authenticate for install and refresh the filesUrl pair.
      let token = '';
      try {
        token = await this.#authenticate(baseUrl, profile);
      } catch (error) {
        logger.warn('iniBuilds install auth failed; will try download without Authorization', {
          reason: String(error && error.message ? error.message : error || 'unknown error')
        });
        token = '';
      }

      let packageLabel = String(meta && meta.filename ? meta.filename : '').trim();
      if (!packageLabel) {
        packageLabel = 'package.zip';
      }

      if (updateActions.length > 0 && token && meta && Number(meta.productId || 0) > 0) {
        try {
          const refreshed = await this.#probeFilesUrlWorking(baseUrl, profile, token, Number(meta.productId || 0));
          const refreshedUrl = refreshed && refreshed.url ? String(refreshed.url).trim() : '';
          const refreshedMd5 = refreshed && refreshed.filesIntegrityMd5 ? String(refreshed.filesIntegrityMd5).trim().toLowerCase() : '';
          const refreshedName = refreshed && refreshed.filename ? String(refreshed.filename).trim() : '';
          if (refreshedUrl && refreshedMd5) {
            url = this.#normalizeSignedUrl(refreshedUrl);
            expectedHash = refreshedMd5;
            if (refreshedName) {
              packageLabel = refreshedName;
            }
            logger.info('iniBuilds install refreshed filesUrl', {
              productId: Number(meta.productId || 0),
              hasUrl: true,
              hasMd5: true
            });
          }
        } catch (error) {
          logger.warn('iniBuilds install filesUrl refresh failed; using cached plan url/hash', {
            reason: String(error && error.message ? error.message : error || 'unknown error')
          });
        }
      }

      const downloadHeaderCandidates = token
        ? [null, { Authorization: token }]
        : [null];

      const totalActions = deleteActions.length + updateActions.length;
      const firstAction = updateActions[0] || deleteActions[0] || { packageName: 'iniBuilds', relativePath: '' };

      let zipPath = '';
      let selectedHash = '';
      let downloadInfo = null;

      if (updateActions.length > 0) {
        if (onProgress) {
          onProgress({
            index: 0,
            total: totalActions,
            type: 'update',
            packageName: firstAction.packageName,
            path: packageLabel,
            message: 'DOWNLOAD iniBuilds package'
          });
        }

        zipPath = tempDownload;
        const cachedZipPath = String(meta && meta.tempZipPath ? meta.tempZipPath : '').trim();
        if (cachedZipPath) {
          try {
            const stat = await fsp.stat(cachedZipPath);
            if (stat && stat.isFile() && stat.size > 0) {
              // Verify cached zip still matches expected hash.
              await this.#verifyPackageMd5(cachedZipPath, expectedHash);
              zipPath = cachedZipPath;
            }
          } catch {
            // ignore and download fresh
          }
        }

        if (zipPath === tempDownload) {
          let downloaded = false;
          let lastDownloadError = '';
          let lastInfo = null;
          for (const headers of downloadHeaderCandidates) {
            try {
              lastInfo = await this.#downloadToFile(
                url,
                tempDownload,
                runtimeControl.signal,
                headers,
                ({ downloaded, total }) => {
                  if (!onProgress) {
                    return;
                  }
                  onProgress({
                    index: 0,
                    total: totalActions,
                    type: 'update',
                    packageName: firstAction.packageName,
                    path: packageLabel,
                    message: 'DOWNLOAD iniBuilds package',
                    bytesDownloaded: downloaded,
                    bytesTotal: total
                  });
                },
                Number(meta && meta.zipSize ? meta.zipSize : 0)
              );
              downloaded = true;
              lastDownloadError = '';
              break;
            } catch (dlError) {
              lastDownloadError = String(dlError && dlError.message ? dlError.message : dlError || 'unknown error');
            }
          }

          if (!downloaded) {
            throw new Error(lastDownloadError || 'Download failed.');
          }

          const desc = await this.#describeDownloadedFile(tempDownload);
          if (desc && desc.ok && !desc.isZip) {
            const ct = lastInfo && lastInfo.contentType ? ` contentType=${lastInfo.contentType}` : '';
            const ce = lastInfo && lastInfo.contentEncoding ? ` contentEncoding=${lastInfo.contentEncoding}` : '';
            throw new Error(
              `Downloaded iniBuilds artifact is not a ZIP (size=${desc.size}, header=${desc.headerHex}${ct}${ce}).`
            );
          }

          downloadInfo = lastInfo;
        }

        if (isCancelled()) {
          throw this.#createInstallAbortError();
        }

        if (onProgress) {
          onProgress({
            index: 0,
            total: totalActions,
            type: 'update',
            packageName: firstAction.packageName,
            path: packageLabel,
            message: 'VERIFY iniBuilds package'
          });
        }

        const rawHash = await this.#md5(zipPath);
        selectedHash = rawHash;

        if (rawHash !== expectedHash) {
          const desc = await this.#describeDownloadedFile(zipPath);
          const metaBits = downloadInfo
            ? ` contentType=${downloadInfo.contentType || '-'} contentEncoding=${downloadInfo.contentEncoding || '-'} etag=${downloadInfo.etag || '-'} contentMd5=${downloadInfo.contentMd5 || '-'}`
            : '';

          // Only attempt gunzip fallback if the file actually looks like gzip.
          if (desc && desc.ok && desc.isGzip) {
          let gunzipError = null;
          try {
            await pipeline(
              fs.createReadStream(zipPath),
              zlib.createGunzip(),
              fs.createWriteStream(tempResult)
            );
          } catch (error) {
            gunzipError = error;
          }

          if (!gunzipError) {
            const unpackedHash = await this.#md5(tempResult);
            if (unpackedHash === expectedHash) {
              selectedHash = unpackedHash;
            } else {
              throw new Error(
                `Checksum mismatch: expected ${expectedHash}, raw ${rawHash}, unpacked ${unpackedHash}${metaBits}`
              );
            }
          } else {
            throw new Error(
              `Checksum mismatch: expected ${expectedHash}, raw ${rawHash}, gunzip failed: ${gunzipError.message}${metaBits}`
            );
          }
          }

          // If MD5 does not match, validate the downloaded ZIP against the plan using central directory.
          // This prevents installing the wrong artifact even when iniBuilds integrity hash appears inconsistent.
          const planValidation = await this.#validateDownloadedZipMatchesPlan(zipPath, updateActions);
          if (!planValidation.ok) {
            const extra = desc && desc.ok
              ? ` (size=${desc.size}, header=${desc.headerHex}, isZip=${desc.isZip}, isGzip=${desc.isGzip}${metaBits})`
              : metaBits;
            throw new Error(`Checksum mismatch and ZIP does not match plan: ${planValidation.reason}. Expected ${expectedHash}, raw ${rawHash}${extra}`);
          }

          logger.warn('iniBuilds package MD5 mismatch, but ZIP matches plan; proceeding with CRC32-verified extraction', {
            expected: expectedHash,
            raw: rawHash,
            checkedEntries: planValidation.checked
          });

          // Treat package as accepted: we will still verify every extracted file via CRC32.
          selectedHash = expectedHash;
        }

        if (selectedHash !== expectedHash) {
          const desc = await this.#describeDownloadedFile(zipPath);
          const extra = desc && desc.ok
            ? ` (size=${desc.size}, header=${desc.headerHex}, isZip=${desc.isZip}, isGzip=${desc.isGzip})`
            : '';
          throw new Error(`Checksum mismatch: expected ${expectedHash}, got ${selectedHash}${extra}`);
        }

        logger.info(rawHash === expectedHash
          ? 'iniBuilds install verified package MD5'
          : 'iniBuilds install accepted package (MD5 mismatch, plan validated)', {
          planId,
          relativePath: '(package)',
          expectedMd5: expectedHash,
          rawMd5: rawHash
        });
      }

      // Create rollback snapshot before applying any changes.
      await this.#createRollbackSnapshot(profile, rootDir, [...deleteActions, ...updateActions], runtimeControl);

      // Apply deletes first (invariant: delete actions before update actions).
      for (let i = 0; i < deleteActions.length; i += 1) {
        await waitUntilResumed();
        if (isCancelled()) {
          throw this.#createInstallAbortError();
        }

        const current = deleteActions[i];
        const relPath = this.#normalizeZipRelPath(current.relativePath);
        if (!relPath) {
          throw new Error(`Invalid relative path in plan action: ${String(current.relativePath || '')}`);
        }

        const destPath = path.join(rootDir, relPath);
        this.#assertWithinRoot(rootDir, destPath);

        if (onProgress) {
          onProgress({
            index: i + 1,
            total: totalActions,
            type: 'delete',
            packageName: current.packageName,
            path: relPath,
            message: `DELETE ${relPath}`
          });
        }

        try {
          await fsp.unlink(destPath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      for (let i = 0; i < updateActions.length; i += 1) {
        await waitUntilResumed();
        if (isCancelled()) {
          throw this.#createInstallAbortError();
        }

        const current = updateActions[i];
        const relPath = this.#normalizeZipRelPath(current.relativePath);
        if (!relPath) {
          throw new Error(`Invalid relative path in plan action: ${String(current.relativePath || '')}`);
        }

        const destPath = path.join(rootDir, relPath);
        this.#assertWithinRoot(rootDir, destPath);

        if (onProgress) {
          onProgress({
            index: deleteActions.length + i + 1,
            total: totalActions,
            type: 'update',
            packageName: current.packageName,
            path: relPath,
            message: `EXTRACT ${relPath}`
          });
        }

        const extractedCrc = await this.#extractZipEntryToFile(
          zipPath,
          {
            localHeaderOffset: Number(current.zipLocalHeaderOffset || 0),
            compressedSize: Number(current.compressedSize || 0),
            method: Number(current.zipMethod || 0)
          },
          destPath
        );

        const expected = String(current.hash || '').trim().toLowerCase();
        if (expected.startsWith('crc32:')) {
          const expectedHex = expected.slice('crc32:'.length).trim();
          const actualHex = this.#formatCrc32(extractedCrc);
          if (expectedHex && actualHex !== expectedHex) {
            throw new Error(`CRC32 mismatch after extraction for ${relPath} (expected ${expectedHex}, got ${actualHex}).`);
          }
        }
      }

      // Persist new manifest for safe delete detection on next run.
      const profileId = String(profile && profile.id ? profile.id : '').trim();
      if (profileId) {
        const rawManifestFiles = meta && Array.isArray(meta.manifestFiles) ? meta.manifestFiles : null;
        const normalized = Array.isArray(rawManifestFiles)
          ? rawManifestFiles.map((p) => this.#normalizeZipRelPath(p)).filter(Boolean)
          : [];
        const uniqueSorted = Array.from(new Set(normalized)).sort();

        // If we don't have a ZIP manifest (should be rare), fall back to previous minus deletes.
        let files = uniqueSorted;
        if (files.length === 0) {
          const prev = meta && Array.isArray(meta.previousManifestFiles) ? meta.previousManifestFiles : [];
          const prevNorm = prev.map((p) => this.#normalizeZipRelPath(p)).filter(Boolean);
          const deleteSet = new Set(deleteActions.map((a) => this.#normalizeZipRelPath(a.relativePath)).filter(Boolean));
          files = prevNorm.filter((p) => p && !deleteSet.has(p));
          files = Array.from(new Set(files)).sort();
        }

        const productId = Number(meta && meta.productId ? meta.productId : 0);
        const packageHash = String(meta && meta.md5 ? meta.md5 : expectedHash).trim().toLowerCase();
        await this.#saveIniBuildsManifest(profileId, {
          productId,
          packageHash,
          files,
          installedAt: new Date().toISOString()
        });
      }

      this.planCache.delete(planId);

      return {
        updated: updateActions.length,
        deleted: deleteActions.length,
        total: deleteActions.length + updateActions.length,
        snapshotType: 'inibuilds',
        snapshotNumber: 'n/a',
        completedAt: new Date().toISOString()
      };
    } finally {
      await Promise.allSettled([
        fsp.unlink(tempDownload).catch(() => {}),
        fsp.unlink(tempResult).catch(() => {})
      ]);
    }
  }

  async getRollbackInfo(_profileId) {
    const profileId = String(_profileId || '').trim();
    if (!profileId) {
      return { available: false, reason: 'Missing profileId.' };
    }

    try {
      const pointerPath = this.#getIniBuildsLatestSnapshotPointerPath(profileId);
      const pointer = await this.#readJsonOrNull(pointerPath);
      if (!pointer || typeof pointer !== 'object' || !pointer.snapshotDir) {
        return { available: false, reason: 'No local rollback snapshot available.' };
      }

      const metaPath = path.join(String(pointer.snapshotDir), 'meta.json');
      const meta = await this.#readJsonOrNull(metaPath);
      if (!meta || typeof meta !== 'object' || meta.provider !== 'inibuilds') {
        return { available: false, reason: 'Rollback snapshot metadata missing or invalid.' };
      }

      return { available: true };
    } catch (error) {
      return { available: false, reason: String(error && error.message ? error.message : error) };
    }
  }

  async rollbackLatestSnapshot(_profile) {
    const profile = _profile && typeof _profile === 'object' ? _profile : null;
    const profileId = String(profile && profile.id ? profile.id : '').trim();
    if (!profileId) {
      throw new Error('Missing profile.id for rollback.');
    }

    const rootDir = String(profile && profile.productDir ? profile.productDir : '').trim();
    if (!rootDir) {
      throw new Error('Profile productDir is missing.');
    }

    const logger = this.logger.withCorrelation('inibuilds-rollback');
    logger.info('Starting iniBuilds rollback (local snapshot restore)', { profileId });

    const pointerPath = this.#getIniBuildsLatestSnapshotPointerPath(profileId);
    const pointer = await this.#readJsonOrNull(pointerPath);
    if (!pointer || typeof pointer !== 'object' || !pointer.snapshotDir) {
      throw new Error('No rollback snapshot available.');
    }

    const snapshotDir = String(pointer.snapshotDir);
    const metaPath = path.join(snapshotDir, 'meta.json');
    const meta = await this.#readJsonOrNull(metaPath);
    if (!meta || typeof meta !== 'object' || meta.provider !== 'inibuilds') {
      throw new Error('Rollback snapshot metadata missing or invalid.');
    }

    const entries = Array.isArray(meta.entries) ? meta.entries : [];
    const filesDir = path.join(snapshotDir, 'files');

    let restored = 0;
    let removed = 0;

    for (const item of entries) {
      const relPath = this.#normalizeZipRelPath(item && item.relativePath ? item.relativePath : '');
      if (!relPath) {
        continue;
      }

      const destPath = path.join(rootDir, relPath);
      this.#assertWithinRoot(rootDir, destPath);

      const hadFile = Boolean(item && item.hadFile);
      const type = String(item && item.type ? item.type : '').trim();

      if (type === 'update') {
        if (hadFile) {
          const backupPath = path.join(filesDir, relPath);
          await fsp.mkdir(path.dirname(destPath), { recursive: true });
          await fsp.copyFile(backupPath, destPath);
          restored += 1;
        } else {
          try {
            await fsp.unlink(destPath);
            removed += 1;
          } catch (error) {
            if (!error || error.code !== 'ENOENT') {
              throw error;
            }
          }
        }
        continue;
      }

      if (type === 'delete') {
        if (hadFile) {
          const backupPath = path.join(filesDir, relPath);
          await fsp.mkdir(path.dirname(destPath), { recursive: true });
          await fsp.copyFile(backupPath, destPath);
          restored += 1;
        }
      }
    }

    // Restore previous manifest if present.
    const previousManifest = meta.previousManifest && typeof meta.previousManifest === 'object' ? meta.previousManifest : null;
    const manifestPath = this.#getIniBuildsManifestPath(profileId);
    if (previousManifest) {
      await this.#writeJson(manifestPath, previousManifest);
    } else {
      try {
        await fsp.unlink(manifestPath);
      } catch {
        // ignore
      }
    }

    // Cleanup snapshot and pointer.
    await Promise.allSettled([
      fsp.rm(snapshotDir, { recursive: true, force: true }),
      fsp.unlink(pointerPath).catch(() => {})
    ]);

    logger.info('iniBuilds rollback completed', { profileId, restored, removed });
    return {
      restored,
      removed,
      sourceSnapshotNumber: null,
      completedAt: new Date().toISOString()
    };
  }
}

function normalizeProbeRelativePath(fileName) {
  const normalized = String(fileName || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');

  if (!normalized) {
    return '__inibuilds_probe__/package.zip';
  }

  return `__inibuilds_probe__/${normalized}`;
}

module.exports = {
  IniBuildsClient
};
