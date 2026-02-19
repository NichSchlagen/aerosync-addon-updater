const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class UpdateHttpError extends Error {
  constructor(status, data) {
    super(`HTTP ${status}${data ? `: ${data}` : ''}`);
    this.name = 'UpdateHttpError';
    this.status = status;
    this.data = data;
  }
}

function normalizeHost(host) {
  const raw = String(host || '').trim();
  if (!raw) {
    throw new Error('Missing update host.');
  }

  return raw.replace(/\/$/, '');
}

function normalizeRelPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  const safe = path.posix.normalize(`/${normalized}`).slice(1);
  if (!safe || safe.startsWith('..')) {
    throw new Error(`Unsafe file path from server: ${relPath}`);
  }

  return safe;
}

function isPathWithinRoot(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveRelativePathWithinRoot(rootPath, rawRelativePath, label) {
  const root = path.resolve(rootPath);
  const raw = String(rawRelativePath || '').trim();
  if (!raw) {
    return root;
  }

  const safeRel = normalizeRelPath(raw);
  const resolved = path.resolve(root, ...safeRel.split('/'));
  if (!isPathWithinRoot(root, resolved)) {
    throw new Error(`Unsafe ${label} path from server: ${rawRelativePath}`);
  }

  return resolved;
}

function normalizeIgnoreEntries(rawIgnoreList) {
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileIgnoreMatchers(rawIgnoreList) {
  const entries = normalizeIgnoreEntries(rawIgnoreList);
  const out = [];

  for (const entry of entries) {
    const normalizedEntry = normalizeRelPath(entry);

    if (normalizedEntry.endsWith('/')) {
      const prefix = normalizedEntry.slice(0, -1);
      out.push((relativePath) => relativePath === prefix || relativePath.startsWith(prefix + '/'));
      continue;
    }

    const hasWildcards = /[*?]/.test(normalizedEntry);
    if (hasWildcards) {
      let regexText = '^' + escapeRegex(normalizedEntry) + '$';
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

function shouldIgnoreRelativePath(relativePath, ignoreMatchers) {
  if (!Array.isArray(ignoreMatchers) || ignoreMatchers.length === 0) {
    return false;
  }

  const normalizedPath = normalizeRelPath(relativePath);
  return ignoreMatchers.some((matcher) => {
    try {
      return Boolean(matcher(normalizedPath));
    } catch {
      return false;
    }
  });
}

function parseJsonSafe(text) {
  if (!text || !text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function queryHeaders() {
  return {
    'User-Agent': 'AeroSync-Addon-Updater/0.1.0',
    'X-Addon-Updater-OS': `${os.platform()} ${os.release()} ${os.arch()}`,
    'X-Addon-Updater-Runtime': `Node ${process.version}`
  };
}

function normalizeLink(link) {
  if (!link || typeof link !== 'object') {
    return { href: '', template: false, method: 'GET' };
  }

  return {
    href: String(link.href || link.mHref || ''),
    template: Boolean(link.template || link.mTemplate),
    method: String(link.method || link.mMethod || 'GET').toUpperCase()
  };
}

function normalizeFileState(rawState) {
  const numeric = Number(rawState);
  if (Number.isFinite(numeric)) {
    switch (numeric) {
      case 0:
        return 'NONE';
      case 1:
        return 'ADD';
      case 2:
        return 'UPDATE';
      case 3:
        return 'DELETE';
      default:
        return String(rawState || 'NONE').toUpperCase();
    }
  }

  const txt = String(rawState || 'NONE').toUpperCase();
  if (txt === '0') return 'NONE';
  if (txt === '1') return 'ADD';
  if (txt === '2') return 'UPDATE';
  if (txt === '3') return 'DELETE';
  return txt;
}

function normalizeFileInfo(file) {
  const links = file._links || file.mLinks || {};
  return {
    location: String(file.location || file.mLocation || ''),
    compressedSize: Number(file.compressedSize ?? file.mCompressedSize ?? 0),
    realSize: Number(file.size ?? file.mRealSize ?? 0),
    state: normalizeFileState(file.state ?? file.mState ?? 'NONE'),
    hash: String(file.hash || file.mHash || '').toLowerCase(),
    links
  };
}

function normalizeProductLocation(location) {
  const source = location || {};
  const detection = source.detection || source.mDetection || [];

  return {
    path: String(source.path || source.mPath || ''),
    detection: Array.isArray(detection) ? detection.map((item) => String(item)) : []
  };
}

function normalizeSnapshot(snapshot) {
  const links = snapshot._links || snapshot.mLinks || {};

  return {
    type: String(snapshot.type || snapshot.mType || '').toLowerCase(),
    number: Number(snapshot.number || snapshot.mNumber || 0),
    shortDesc: String(snapshot.shortDesc || snapshot.mShortDesc || ''),
    fullDesc: String(snapshot.fullDesc || snapshot.mFullDesc || ''),
    links
  };
}

function normalizeProduct(product) {
  const snapshots = product.snapshots || product.mSnapshots || [];
  const subProducts = product.subProducts || product.mSubProducts || [];
  const links = product._links || product.mLinks || {};

  return {
    id: String(product.id || product.mId || ''),
    name: String(product.name || product.mName || 'Unknown Product'),
    distributor: String(product.distributor || product.mDistributor || ''),
    blocked: String(product.blockMessage || product.mBlocked || ''),
    location: normalizeProductLocation(product.location || product.mLocation),
    snapshots: Array.isArray(snapshots) ? snapshots.map(normalizeSnapshot) : [],
    subProducts: Array.isArray(subProducts) ? subProducts.map(normalizeProduct) : [],
    links
  };
}

function normalizeOptionalPackageSelections(rawSelections) {
  if (!rawSelections || typeof rawSelections !== 'object' || Array.isArray(rawSelections)) {
    return new Map();
  }

  const out = new Map();

  for (const [rawId, rawAction] of Object.entries(rawSelections)) {
    const id = String(rawId || '').trim();
    if (!id) {
      continue;
    }

    const action = String(rawAction || '').trim().toLowerCase();
    if (action !== 'install' && action !== 'ignore') {
      continue;
    }

    out.set(id, action);
  }

  return out;
}

function flattenProducts(rootProduct) {
  const out = [];

  function walk(product) {
    out.push(product);
    for (const sub of product.subProducts) {
      walk(sub);
    }
  }

  walk(rootProduct);
  return out;
}

function pickSnapshot(product, options, warnings) {
  const list = Array.isArray(product.snapshots) ? product.snapshots : [];
  if (!list.length) {
    throw new Error(`${product.name} has no snapshots.`);
  }

  const byType = new Map(list.map((item) => [item.type, item]));
  const pushWarn = (msg) => {
    if (!Array.isArray(warnings)) {
      return;
    }

    warnings.push(msg);
  };

  if (options.alpha) {
    if (byType.has('alpha')) {
      return byType.get('alpha');
    }

    pushWarn(`Alpha requested but unavailable for ${product.name}. Using fallback.`);
    if (byType.has('beta')) {
      return byType.get('beta');
    }
  }

  if (options.beta && byType.has('beta')) {
    return byType.get('beta');
  }

  if (byType.has('release')) {
    if (options.beta && !byType.has('beta')) {
      pushWarn(`Beta requested but unavailable for ${product.name}. Using release.`);
    }
    return byType.get('release');
  }

  if (options.beta && !byType.has('beta')) {
    pushWarn(`Beta requested but unavailable for ${product.name}. Using first available snapshot.`);
  }

  pushWarn(`Release missing for ${product.name}. Using first available snapshot.`);
  return list[0];
}

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}


function exists(filePath) {
  return Boolean(statSafe(filePath));
}

function resolveDetectionAnchor(candidatePath) {
  const stat = statSafe(candidatePath);
  if (!stat) {
    return null;
  }

  if (stat.isDirectory()) {
    return candidatePath;
  }

  if (stat.isFile()) {
    return path.dirname(candidatePath);
  }

  return null;
}

function resolveProductDir(rootDir, location) {
  const root = path.resolve(rootDir);
  const base = resolveRelativePathWithinRoot(root, location.path || '', 'product location');
  const rootWithSep = `${root}${path.sep}`;
  const detectionEntries = Array.isArray(location.detection)
    ? location.detection
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => normalizeRelPath(item))
    : [];

  if (!detectionEntries.length) {
    return {
      dir: base,
      detected: true
    };
  }

  const findAnchorFromBase = (anchorBase) => {
    if (!isPathWithinRoot(root, anchorBase)) {
      return null;
    }

    const candidatePaths = [];

    // Most APIs provide detection entries as alternative marker paths.
    for (const marker of detectionEntries) {
      candidatePaths.push(resolveRelativePathWithinRoot(anchorBase, marker, 'detection marker'));
    }

    // Keep compatibility for payloads that provide path segments instead.
    if (detectionEntries.length > 1) {
      candidatePaths.push(resolveRelativePathWithinRoot(
        anchorBase,
        path.posix.join(...detectionEntries),
        'detection marker'
      ));
    }

    const seen = new Set();
    for (const candidatePath of candidatePaths) {
      if (seen.has(candidatePath)) {
        continue;
      }
      seen.add(candidatePath);

      const anchor = resolveDetectionAnchor(candidatePath);
      if (anchor && isPathWithinRoot(root, anchor)) {
        return anchor;
      }
    }

    return null;
  };

  const directAnchor = findAnchorFromBase(base);
  if (directAnchor) {
    return {
      dir: directAnchor,
      detected: true
    };
  }

  let cursor = base;
  while (cursor === root || cursor.startsWith(rootWithSep)) {
    const anchor = findAnchorFromBase(cursor);
    if (anchor) {
      return {
        dir: anchor,
        detected: true
      };
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }

    cursor = parent;
  }

  return {
    dir: base,
    detected: false
  };
}
function resolveAbsoluteUrl(baseHost, href) {
  if (!href) {
    throw new Error('Invalid empty API link.');
  }

  if (/^\/\//.test(href)) {
    return `https:${href}`;
  }

  if (/^https?:\/\//i.test(href)) {
    return href;
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}\/.+/i.test(href)) {
    return `https://${href}`;
  }

  return `${baseHost}${href.startsWith('/') ? '' : '/'}${href}`;
}

function appendSinceIfTemplate(urlString, isTemplate, since) {
  if (!isTemplate || !Number.isFinite(Number(since)) || Number(since) <= 0) {
    return urlString;
  }

  const url = new URL(urlString);
  url.searchParams.set('since', String(Number(since)));
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const { createLogger } = require('./logger');

function createInstallAbortError() {
  const error = new Error('Installation cancelled by user.');
  error.code = 'INSTALL_CANCELLED';
  return error;
}

class UpdateClient {
  constructor({ tempDir, snapshotDir }) {
    this.tempDir = tempDir;
    this.snapshotDir = snapshotDir;
    this.planCache = new Map();
    this.logger = createLogger('update-client');
    this.PLAN_TTL_MS = 30 * 60 * 1000; // 30 minutes
    this.MAX_SNAPSHOTS_PER_PROFILE = 5;

    // Start periodic cleanup of expired plans
    this.#startPlanCacheCleanup();
  }

  #startPlanCacheCleanup() {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.#cleanupExpiredPlans();
    }, 5 * 60 * 1000);

    // Don't prevent process from exiting
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  #cleanupExpiredPlans() {
    const now = Date.now();
    let removedCount = 0;

    for (const [planId, plan] of this.planCache.entries()) {
      const age = now - plan.createdAt;
      if (age > this.PLAN_TTL_MS) {
        this.planCache.delete(planId);
        removedCount += 1;
        this.logger.debug('Expired plan removed from cache', { planId, ageMinutes: Math.floor(age / 60000) });
      }
    }

    if (removedCount > 0) {
      this.logger.info('Plan cache cleanup completed', { removedCount, remainingCount: this.planCache.size });
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async #fetchText(url, requestOptions = {}) {
    const controller = new AbortController();
    const timeoutMs = Number(requestOptions.timeoutMs || 45000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startTime = Date.now();

    try {
      this.logger.debug('HTTP request started', { url, method: requestOptions.method || 'GET', timeoutMs });

      const response = await fetch(url, {
        method: requestOptions.method || 'GET',
        headers: requestOptions.headers || {},
        redirect: requestOptions.redirect || 'follow',
        signal: controller.signal
      });

      const text = await response.text();
      const duration = Date.now() - startTime;

      this.logger.debug('HTTP request completed', { 
        url, 
        status: response.status, 
        durationMs: duration,
        responseSize: text.length 
      });

      return {
        status: response.status,
        headers: response.headers,
        text,
        json: parseJsonSafe(text)
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error && error.name === 'AbortError') {
        this.logger.warn('HTTP request timeout', { url, timeoutMs, durationMs: duration });
        throw new Error(`Request timeout after ${timeoutMs}ms for ${url}`);
      }

      this.logger.error('HTTP request failed', { url, error: error.message, durationMs: duration });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #fetchJson(url, requestOptions = {}) {
    const result = await this.#fetchText(url, requestOptions);
    if (result.status >= 400) {
      this.logger.warn('HTTP error response', { url, status: result.status });
      throw new UpdateHttpError(result.status, result.text);
    }

    if (!result.json) {
      this.logger.error('Invalid JSON response', { url, responseStart: result.text.slice(0, 100) });
      throw new Error(`Invalid JSON response from ${url}`);
    }

    return result.json;
  }

  async #downloadToFile(url, filePath, headers, cancelSignal) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 180000);
    const signal = cancelSignal
      ? AbortSignal.any([timeoutController.signal, cancelSignal])
      : timeoutController.signal;

    if (cancelSignal && cancelSignal.aborted) {
      throw createInstallAbortError();
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new UpdateHttpError(response.status, body);
      }

      if (!response.body) {
        throw new Error(`Empty response body for download: ${url}`);
      }

      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const bodyStream = Readable.fromWeb(response.body);
      await pipeline(bodyStream, fs.createWriteStream(filePath));
    } catch (error) {
      if (cancelSignal && cancelSignal.aborted) {
        throw createInstallAbortError();
      }

      if (error && error.name === 'AbortError') {
        throw new Error(`Download timeout for ${url}`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #md5(filePath) {
    const hash = crypto.createHash('md5');

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', resolve);
    });

    return hash.digest('hex').toLowerCase();
  }

  async #authorize(profile) {
    const basicRaw = Buffer.from(`${profile.login}:${profile.licenseKey}`, 'utf8').toString('base64');
    const basic = `Basic ${basicRaw}`;
    const authUrl = `${profile.host}/api/v2/service/auth/consumers`;
    const maxAttempts = 4;

    const expandCandidate = (inputValue) => {
      const raw = String(inputValue || '').trim();
      if (!raw) {
        return [];
      }

      const out = [raw];
      if (/^https?:\/\//i.test(raw)) {
        try {
          const u = new URL(raw);
          out.push(u.pathname);

          const lastPathPart = u.pathname.split('/').filter(Boolean).at(-1);
          if (lastPathPart) {
            out.push(lastPathPart);
            out.push(`Bearer ${lastPathPart}`);
            out.push(`Token ${lastPathPart}`);
          }
        } catch {
          // Ignore URL parse errors, raw candidate is still kept.
        }
      } else if (raw.startsWith('/')) {
        out.push(resolveAbsoluteUrl(profile.host, raw));
        const lastPathPart = raw.split('/').filter(Boolean).at(-1);
        if (lastPathPart) {
          out.push(lastPathPart);
          out.push(`Bearer ${lastPathPart}`);
          out.push(`Token ${lastPathPart}`);
        }
      } else if (!/^bearer\s+/i.test(raw) && !/^basic\s+/i.test(raw) && !/^token\s+/i.test(raw)) {
        out.push(`Bearer ${raw}`);
        out.push(`Token ${raw}`);
      }

      return out;
    };

    const attemptStatuses = [];
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await this.#fetchText(authUrl, {
        method: 'POST',
        headers: {
          ...queryHeaders(),
          Authorization: basic,
          UserName: profile.login,
          Key: profile.licenseKey
        },
        timeoutMs: 30000,
        redirect: 'manual'
      });

      attemptStatuses.push(result.status);

      if (result.status >= 400 && result.status !== 429) {
        throw new UpdateHttpError(result.status, result.text);
      }

      const rawCandidates = [];
      rawCandidates.push(result.headers.get('authorization'));
      rawCandidates.push(result.headers.get('location'));

      if (result.json && typeof result.json === 'object') {
        rawCandidates.push(result.json.token);
        rawCandidates.push(result.json.access_token);
        rawCandidates.push(result.json.authorization);
        rawCandidates.push(result.json.location);
      }

      const bodyTokenCandidate = String(result.text || '').trim();
      if (
        bodyTokenCandidate &&
        bodyTokenCandidate.length <= 1024 &&
        !bodyTokenCandidate.startsWith('{') &&
        !bodyTokenCandidate.startsWith('[') &&
        !bodyTokenCandidate.startsWith('<')
      ) {
        rawCandidates.push(bodyTokenCandidate);
      }

      const expandedCandidates = rawCandidates.flatMap(expandCandidate).filter(Boolean);
      const authHeaderCandidates = Array.from(new Set([...expandedCandidates, basic]));

      if (result.status < 400 && result.status !== 202 && authHeaderCandidates.length > 0) {
        return {
          authHeaderCandidates,
          basicHeader: basic
        };
      }

      if (result.status === 202 || result.status === 429) {
        const retryAfterRaw = result.headers.get('retry-after');
        const retryAfterSec = Math.min(10, Math.max(1, Number.parseInt(retryAfterRaw || '1', 10) || 1));
        if (attempt < maxAttempts) {
          await sleep(retryAfterSec * 1000);
          continue;
        }
      }

      lastError = new UpdateHttpError(result.status, result.text);
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(`Authorization failed. Status attempts: ${attemptStatuses.join(', ')}`);
  }

  async #fetchProductInfo(profile, authCandidates, basicHeader) {
    const updatesUrl = `${profile.host}/api/v2/experimental/updates`;

    const requestStrategies = [];
    for (const candidate of authCandidates) {
      requestStrategies.push({
        authHeaders: { Authorization: candidate },
        strategy: 'authorization-only'
      });
      requestStrategies.push({
        authHeaders: {
          Authorization: candidate,
          UserName: profile.login,
          Key: profile.licenseKey
        },
        strategy: 'authorization-plus-userkey'
      });
    }

    requestStrategies.push({
      authHeaders: { Authorization: basicHeader },
      strategy: 'basic-only'
    });
    requestStrategies.push({
      authHeaders: {
        Authorization: basicHeader,
        UserName: profile.login,
        Key: profile.licenseKey
      },
      strategy: 'basic-plus-userkey'
    });

    const uniqueStrategies = [];
    const seen = new Set();
    for (const item of requestStrategies) {
      const key = JSON.stringify(item.authHeaders);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      uniqueStrategies.push(item);
    }

    let lastError = null;
    const attemptStatuses = [];

    for (const strategy of uniqueStrategies) {
      try {
        const response = await this.#fetchJson(updatesUrl, {
          method: 'GET',
          headers: {
            ...queryHeaders(),
            ...strategy.authHeaders
          },
          timeoutMs: 45000
        });

        const productsRaw = Array.isArray(response)
          ? response
          : response.products || response.mProductsInfo || [];

        if (!Array.isArray(productsRaw) || productsRaw.length === 0) {
          throw new Error('No products returned for this account.');
        }

        const rootProduct = normalizeProduct(productsRaw[0]);
        return {
          authHeaders: strategy.authHeaders,
          rootProduct
        };
      } catch (error) {
        lastError = error;
        const status = error instanceof UpdateHttpError ? error.status : 'ERR';
        attemptStatuses.push(`${strategy.strategy}:${status}`);
      }
    }

    if (attemptStatuses.length > 0) {
      throw new Error(
        `Could not fetch product info. Tried ${attemptStatuses.length} auth strategies. Results: ${attemptStatuses.join(', ')}`
      );
    }

    throw lastError || new Error('Could not fetch product information.');
  }

  async #fetchFileList(url, authHeaders) {
    const response = await this.#fetchJson(url, {
      method: 'GET',
      headers: {
        ...queryHeaders(),
        ...authHeaders
      },
      timeoutMs: 60000
    });

    const rawItems = Array.isArray(response)
      ? response
      : response.files || response.items || response.mFiles || [];

    if (!Array.isArray(rawItems)) {
      throw new Error(`Unexpected file list payload from ${url}`);
    }

    return rawItems.map(normalizeFileInfo);
  }

  async #collectFiles(baseDir) {
    const out = [];
    if (!exists(baseDir)) {
      return out;
    }

    const stack = [baseDir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await fsp.readdir(current, { withFileTypes: true });

      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const relative = path.relative(baseDir, absolute).split(path.sep).join('/');
        out.push(relative);
      }
    }

    out.sort();
    return out;
  }

  #resolveActionTarget(packageDir, serverLocation) {
    const safeRel = normalizeRelPath(serverLocation);
    const targetPath = path.resolve(packageDir, ...safeRel.split('/'));
    const packageRoot = path.resolve(packageDir);
    if (!targetPath.startsWith(`${packageRoot}${path.sep}`) && targetPath !== packageRoot) {
      throw new Error(`Path escaped package root: ${safeRel}`);
    }

    return {
      safeRel,
      targetPath
    };
  }

  async #buildPackageActions(productPackage, modes) {
    const fresh = Boolean(modes && modes.fresh);
    const repair = Boolean(modes && modes.repair);
    const actions = [];
    const serverFiles = productPackage.files;
    const serverRelSet = new Set();

    for (const item of serverFiles) {
      const safeRel = normalizeRelPath(item.location);
      serverRelSet.add(safeRel);

      const { targetPath } = this.#resolveActionTarget(productPackage.dir, item.location);
      const isFilePresent = exists(targetPath);
      const state = item.state;

      if (state === 'DELETE') {
        if (!repair && isFilePresent) {
          actions.push({
            type: 'delete',
            state: 'DELETE',
            packageName: productPackage.name,
            packageDir: productPackage.dir,
            relativePath: safeRel,
            targetPath,
            compressedSize: 0,
            realSize: 0
          });
        }

        continue;
      }

      if (repair) {
        let mustUpdate = true;
        if (isFilePresent) {
          const hash = await this.#md5(targetPath);
          mustUpdate = hash !== item.hash;
        }

        if (!mustUpdate) {
          continue;
        }

        const dataLink = normalizeLink(item.links['xu:data']);
        if (!dataLink.href) {
          throw new Error('Missing xu:data link for ' + safeRel + ' (' + productPackage.name + ')');
        }

        actions.push({
          type: 'update',
          state,
          packageName: productPackage.name,
          packageDir: productPackage.dir,
          relativePath: safeRel,
          targetPath,
          compressedSize: item.compressedSize,
          realSize: item.realSize,
          hash: item.hash,
          downloadHref: dataLink.href,
          repairUpdate: true
        });

        continue;
      }

      if (!fresh && state !== 'ADD' && state !== 'UPDATE') {
        continue;
      }

      let mustUpdate = true;
      if (!fresh && isFilePresent) {
        const hash = await this.#md5(targetPath);
        mustUpdate = hash !== item.hash;
      }

      if (!mustUpdate) {
        continue;
      }

      const dataLink = normalizeLink(item.links['xu:data']);
      if (!dataLink.href) {
        throw new Error('Missing xu:data link for ' + safeRel + ' (' + productPackage.name + ')');
      }

      actions.push({
        type: 'update',
        state,
        packageName: productPackage.name,
        packageDir: productPackage.dir,
        relativePath: safeRel,
        targetPath,
        compressedSize: item.compressedSize,
        realSize: item.realSize,
        hash: item.hash,
        downloadHref: dataLink.href
      });
    }

    if (fresh && !repair) {
      const existingFiles = await this.#collectFiles(productPackage.dir);
      for (const relPath of existingFiles) {
        if (serverRelSet.has(relPath)) {
          continue;
        }

        const { targetPath } = this.#resolveActionTarget(productPackage.dir, relPath);
        actions.push({
          type: 'delete',
          state: 'DELETE',
          packageName: productPackage.name,
          packageDir: productPackage.dir,
          relativePath: relPath,
          targetPath,
          compressedSize: 0,
          realSize: 0,
          freshDeletion: true
        });
      }
    }

    return actions;
  }

  async createUpdatePlan(inputProfile, options) {
    const logger = this.logger.withCorrelation('update-check');
    logger.info('Creating update plan', { 
      profileName: inputProfile.name, 
      channel: inputProfile.channel,
      options: {
        alpha: Boolean(options.alpha),
        beta: Boolean(options.beta),
        fresh: Boolean(options.fresh),
        repair: Boolean(options.repair)
      }
    });

    const profile = {
      ...inputProfile,
      host: normalizeHost(inputProfile.host)
    };

    const pickedOptions = {
      alpha: Boolean(options.alpha),
      beta: Boolean(options.beta),
      fresh: Boolean(options.fresh),
      repair: Boolean(options.repair)
    };
    const optionalPackageSelections = normalizeOptionalPackageSelections(options.optionalPackages);

    if (pickedOptions.repair) {
      // Repair mode already verifies and re-downloads mismatched files, so fresh cleanup is disabled.
      pickedOptions.fresh = false;
      logger.info('Repair mode enabled, disabling fresh mode');
    }

    const auth = await this.#authorize(profile);
    logger.debug('Authorization successful');

    const productResponse = await this.#fetchProductInfo(
      profile,
      auth.authHeaderCandidates,
      auth.basicHeader
    );
    logger.debug('Product info fetched', { productCount: flattenProducts(productResponse.rootProduct).length });

    const allProducts = flattenProducts(productResponse.rootProduct);
    const packages = [];
    const optionalPackages = [];
    const warnings = [];

    if (pickedOptions.repair) {
      warnings.push('Repair/verify mode enabled: all known files will be hash-checked.');
    }
    let targetSnapshotNumber = 0;
    let targetSnapshotType = 'release';

    const rootBlockedMessage = String(productResponse.rootProduct.blocked || '').trim();
    if (rootBlockedMessage) {
      warnings.push(
        `Product note (${productResponse.rootProduct.name}): ${rootBlockedMessage}`
      );
    }

    for (const product of allProducts) {
      const blockedMessage = String(product.blocked || '').trim();
      if (blockedMessage) {
        warnings.push(`Product note (${product.name}): ${blockedMessage}`);
      }

      const resolvedProduct = resolveProductDir(profile.productDir, product.location);
      const hasDetectionMarkers = Array.isArray(product.location && product.location.detection)
        && product.location.detection.some((item) => String(item || '').trim().length > 0);
      const defaultAction = resolvedProduct.detected ? 'install' : 'ignore';
      const selectedAction = hasDetectionMarkers
        ? (optionalPackageSelections.get(product.id) || defaultAction)
        : 'install';

      if (hasDetectionMarkers) {
        optionalPackages.push({
          id: product.id,
          name: product.name,
          detected: resolvedProduct.detected,
          defaultAction,
          selectedAction
        });
      }

      if (selectedAction === 'ignore') {
        if (hasDetectionMarkers && !resolvedProduct.detected) {
          warnings.push('Optional package "' + product.name + '" is not relevant for this installation and was skipped.');
        } else if (hasDetectionMarkers) {
          warnings.push('Optional package "' + product.name + '" was set to ignore and was skipped.');
        }
        continue;
      }

      if (hasDetectionMarkers && !resolvedProduct.detected) {
        warnings.push('Optional package "' + product.name + '" was selected for install without detection markers.');
      }

      const snapshot = pickSnapshot(product, pickedOptions, warnings);
      if (snapshot.number > targetSnapshotNumber) {
        targetSnapshotNumber = snapshot.number;
        targetSnapshotType = snapshot.type;
      }

      const link = normalizeLink(snapshot.links['xu:files']);
      if (!link.href) {
        throw new Error(`Missing xu:files link for ${product.name}.`);
      }

      const filesSince = (pickedOptions.fresh || pickedOptions.repair) ? 0 : profile.packageVersion;
      const filesUrl = appendSinceIfTemplate(
        resolveAbsoluteUrl(profile.host, link.href),
        link.template,
        filesSince
      );

      const files = await this.#fetchFileList(filesUrl, productResponse.authHeaders);
      const productDir = resolvedProduct.dir;

      packages.push({
        name: product.name,
        dir: productDir,
        files
      });
    }

    const actions = [];
    for (const productPackage of packages) {
      const part = await this.#buildPackageActions(productPackage, pickedOptions);
      actions.push(...part);
    }

    const ignoreMatchers = compileIgnoreMatchers(profile.ignoreList);
    const ignoredCount = ignoreMatchers.length > 0
      ? actions.filter((action) => shouldIgnoreRelativePath(action.relativePath, ignoreMatchers)).length
      : 0;

    if (ignoredCount > 0) {
      warnings.push('Ignore list skipped ' + ignoredCount + ' action(s).');
    }

    const filteredActions = ignoreMatchers.length > 0
      ? actions.filter((action) => !shouldIgnoreRelativePath(action.relativePath, ignoreMatchers))
      : actions;

    const sortedActions = [
      ...filteredActions.filter((action) => action.type === 'delete'),
      ...filteredActions.filter((action) => action.type === 'update')
    ];
    const updateActions = sortedActions.filter((item) => item.type === 'update');
    const downloadSizeKnown = updateActions.reduce((acc, item) => {
      const compressed = Number(item.compressedSize || 0);
      return compressed > 0 ? acc + compressed : acc;
    }, 0);
    const downloadSizeEstimatedMax = updateActions.reduce((acc, item) => {
      const compressed = Number(item.compressedSize || 0);
      const real = Number(item.realSize || 0);
      return acc + (compressed > 0 ? compressed : real);
    }, 0);
    const downloadSizeUnknownCount = updateActions.filter(
      (item) => Number(item.compressedSize || 0) === 0
    ).length;

    const summary = {
      productName: productResponse.rootProduct.name,
      distributor: productResponse.rootProduct.distributor,
      snapshotType: targetSnapshotType,
      snapshotNumber: targetSnapshotNumber,
      packageCount: packages.length,
      optionalPackageCount: optionalPackages.length,
      optionalIgnoredCount: optionalPackages.filter((item) => item.selectedAction === 'ignore').length,
      optionalForcedInstallCount: optionalPackages.filter(
        (item) => item.selectedAction === 'install' && !item.detected
      ).length,
      fileCount: sortedActions.length,
      ignoredCount,
      deleteCount: sortedActions.filter((item) => item.type === 'delete').length,
      warningCount: Array.from(new Set(warnings)).length,
      repairMode: pickedOptions.repair,
      downloadSize: downloadSizeEstimatedMax,
      downloadSizeKnown,
      downloadSizeEstimatedMax,
      downloadSizeUnknownCount,
      diskSize: updateActions.reduce((acc, item) => acc + Number(item.realSize || 0), 0)
    };

    const uniqueWarnings = Array.from(new Set(warnings));

    const planId = crypto.randomUUID();
    this.planCache.set(planId, {
      createdAt: Date.now(),
      profileId: profile.id,
      host: profile.host,
      authHeaders: productResponse.authHeaders,
      options: pickedOptions,
      actions: sortedActions,
      summary,
      warnings: uniqueWarnings,
      optionalPackages
    });

    logger.info('Update plan created', {
      planId,
      fileCount: sortedActions.length,
      updateCount: summary.fileCount - summary.deleteCount,
      deleteCount: summary.deleteCount,
      ignoredCount: summary.ignoredCount,
      downloadSizeMB: (summary.downloadSize / (1024 * 1024)).toFixed(2),
      warningCount: summary.warningCount
    });

    return {
      planId,
      summary,
      warnings: uniqueWarnings,
      optionalPackages: optionalPackages.map((item) => ({
        id: item.id,
        name: item.name,
        detected: item.detected,
        defaultAction: item.defaultAction,
        selectedAction: item.selectedAction
      })),
      actions: sortedActions.map((item) => ({
        type: item.type,
        state: item.state,
        packageName: item.packageName,
        relativePath: item.relativePath,
        compressedSize: item.compressedSize,
        realSize: item.realSize,
        freshDeletion: Boolean(item.freshDeletion)
      }))
    };
  }

  async #removeFileAndEmptyParents(targetPath, packageRoot) {
    try {
      await fsp.unlink(targetPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }

      throw error;
    }

    const root = path.resolve(packageRoot);
    let cursor = path.dirname(path.resolve(targetPath));

    while (cursor.startsWith(root) && cursor !== root) {
      const entries = await fsp.readdir(cursor);
      if (entries.length > 0) {
        break;
      }

      await fsp.rmdir(cursor);
      cursor = path.dirname(cursor);
    }
  }

  #sanitizeSnapshotProfileId(profileId) {
    const raw = String(profileId || '').trim();
    if (!raw) {
      throw new Error('Missing profile id for snapshot operation.');
    }

    return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  #snapshotProfileDir(profileId) {
    return path.join(this.snapshotDir, this.#sanitizeSnapshotProfileId(profileId));
  }

  async #listSnapshotRoots(profileId) {
    const profileSnapshotDir = this.#snapshotProfileDir(profileId);
    let entries = [];

    try {
      entries = await fsp.readdir(profileSnapshotDir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }

    const roots = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const rootPath = path.join(profileSnapshotDir, entry.name);
      const manifestPath = path.join(rootPath, 'manifest.json');
      try {
        const stat = await fsp.stat(manifestPath);
        roots.push({ rootPath, manifestPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore incomplete snapshot directories.
      }
    }

    roots.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return roots;
  }

  async #readSnapshotManifest(manifestPath) {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const parsed = parseJsonSafe(raw);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Snapshot manifest is invalid JSON.');
    }

    return parsed;
  }

  async #getLatestSnapshot(profileId) {
    const roots = await this.#listSnapshotRoots(profileId);
    for (const entry of roots) {
      try {
        const manifest = await this.#readSnapshotManifest(entry.manifestPath);
        return {
          snapshotRoot: entry.rootPath,
          manifestPath: entry.manifestPath,
          manifest
        };
      } catch {
        // Skip invalid snapshot manifests.
      }
    }

    return null;
  }

  async #pruneOldSnapshots(profileId, keepCount = this.MAX_SNAPSHOTS_PER_PROFILE) {
    const roots = await this.#listSnapshotRoots(profileId);
    const obsolete = roots.slice(Math.max(0, keepCount));

    for (const entry of obsolete) {
      await fsp.rm(entry.rootPath, { recursive: true, force: true });
    }
  }

  async #createInstallSnapshot(profile, planId, plan) {
    const logger = this.logger.withCorrelation('snapshot-create');
    const createdAt = new Date().toISOString();
    const snapshotId = crypto.randomUUID();
    const profileSnapshotDir = this.#snapshotProfileDir(profile.id);
    const snapshotRoot = path.join(profileSnapshotDir, `${Date.now()}-${snapshotId}`);
    const filesRoot = path.join(snapshotRoot, 'files');

    await fsp.mkdir(filesRoot, { recursive: true });

    const entries = [];
    const seenPaths = new Set();

    for (const action of plan.actions) {
      const relativePath = normalizeRelPath(action.relativePath);
      if (seenPaths.has(relativePath)) {
        continue;
      }

      seenPaths.add(relativePath);
      const liveTargetPath = resolveRelativePathWithinRoot(
        profile.productDir,
        relativePath,
        'profile target'
      );

      let hadOriginal = false;
      let backupPath = null;

      try {
        const stat = await fsp.stat(liveTargetPath);
        if (stat.isFile()) {
          hadOriginal = true;
          backupPath = relativePath;
          const snapshotTargetPath = resolveRelativePathWithinRoot(
            filesRoot,
            backupPath,
            'snapshot backup'
          );
          await fsp.mkdir(path.dirname(snapshotTargetPath), { recursive: true });
          await fsp.copyFile(liveTargetPath, snapshotTargetPath);
        }
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          throw error;
        }
      }

      entries.push({
        relativePath,
        hadOriginal,
        backupPath
      });
    }

    const manifest = {
      format: 'aerosync.install-snapshot.v1',
      snapshotId,
      profileId: String(profile.id || ''),
      profileName: String(profile.name || ''),
      planId: String(planId || ''),
      createdAt,
      sourceSnapshotType: 'current',
      sourceSnapshotNumber: Number(profile.packageVersion || 0),
      targetSnapshotType: String(plan?.summary?.snapshotType || ''),
      targetSnapshotNumber: Number(plan?.summary?.snapshotNumber || 0),
      entries
    };

    const manifestPath = path.join(snapshotRoot, 'manifest.json');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await this.#pruneOldSnapshots(profile.id);

    logger.info('Install snapshot created', {
      snapshotId,
      profileId: profile.id,
      entries: entries.length,
      hadOriginalCount: entries.filter((item) => item.hadOriginal).length
    });

    return {
      snapshotId,
      snapshotRoot,
      manifestPath,
      manifest
    };
  }

  async getRollbackInfo(profileId) {
    const latest = await this.#getLatestSnapshot(profileId);
    if (!latest) {
      return {
        available: false
      };
    }

    const manifest = latest.manifest;
    return {
      available: true,
      snapshotId: String(manifest.snapshotId || ''),
      createdAt: String(manifest.createdAt || ''),
      targetSnapshotType: String(manifest.targetSnapshotType || ''),
      targetSnapshotNumber: Number(manifest.targetSnapshotNumber || 0),
      sourceSnapshotType: String(manifest.sourceSnapshotType || ''),
      sourceSnapshotNumber: Number(manifest.sourceSnapshotNumber || 0)
    };
  }

  async rollbackLatestSnapshot(profile) {
    const logger = this.logger.withCorrelation('rollback');
    const latest = await this.#getLatestSnapshot(profile.id);
    if (!latest) {
      throw new Error('No rollback snapshot available for this profile.');
    }

    const manifest = latest.manifest;
    const filesRoot = path.join(latest.snapshotRoot, 'files');
    const entries = Array.isArray(manifest.entries)
      ? [...manifest.entries]
      : [];

    let restored = 0;
    let removed = 0;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const relativePath = normalizeRelPath(entry && entry.relativePath ? entry.relativePath : '');
      const targetPath = resolveRelativePathWithinRoot(profile.productDir, relativePath, 'rollback target');

      if (entry && entry.hadOriginal) {
        const backupRelativePath = normalizeRelPath(entry.backupPath || relativePath);
        const backupPath = resolveRelativePathWithinRoot(filesRoot, backupRelativePath, 'snapshot backup');

        await fsp.mkdir(path.dirname(targetPath), { recursive: true });

        try {
          const targetStat = await fsp.stat(targetPath);
          if (targetStat.isDirectory()) {
            await fsp.rm(targetPath, { recursive: true, force: true });
          }
        } catch {
          // Ignore missing target.
        }

        await fsp.copyFile(backupPath, targetPath);
        restored += 1;
        continue;
      }

      try {
        await this.#removeFileAndEmptyParents(targetPath, profile.productDir);
        removed += 1;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    const completedAt = new Date().toISOString();
    logger.info('Rollback completed', {
      profileId: profile.id,
      snapshotId: manifest.snapshotId,
      restored,
      removed
    });

    await fsp.rm(latest.snapshotRoot, { recursive: true, force: true });

    return {
      snapshotId: String(manifest.snapshotId || ''),
      restored,
      removed,
      sourceSnapshotType: String(manifest.sourceSnapshotType || ''),
      sourceSnapshotNumber: Number(manifest.sourceSnapshotNumber || 0),
      targetSnapshotType: String(manifest.targetSnapshotType || ''),
      targetSnapshotNumber: Number(manifest.targetSnapshotNumber || 0),
      completedAt
    };
  }

  async #installUpdateAction(action, plan, installControl = {}) {
    const emptyHash = 'd41d8cd98f00b204e9800998ecf8427e';
    const expectedHash = String(action.hash || '').toLowerCase();
    const expectedSize = Number(action.realSize || 0);
    const isCancelled = () =>
      Boolean(installControl.isCancelled && installControl.isCancelled())
      || Boolean(installControl.signal && installControl.signal.aborted);

    if (isCancelled()) {
      throw createInstallAbortError();
    }

    // Some payload entries intentionally represent empty marker files.
    // In this case, creating an empty file is the canonical result.
    if (expectedHash === emptyHash && expectedSize === 0) {
      await fsp.mkdir(path.dirname(action.targetPath), { recursive: true });
      await fsp.writeFile(action.targetPath, '');
      return;
    }

    const tempDownload = path.join(this.tempDir, `updater-download-${crypto.randomUUID()}.tmp`);
    const tempResult = path.join(this.tempDir, `updater-result-${crypto.randomUUID()}.tmp`);
    const downloadUrl = resolveAbsoluteUrl(plan.host, action.downloadHref);

    try {
      await this.#downloadToFile(downloadUrl, tempDownload, {
        ...queryHeaders(),
        ...plan.authHeaders
      }, installControl.signal);

      if (isCancelled()) {
        throw createInstallAbortError();
      }

      // Some files are served raw, some are gzip-packed while keeping misleading metadata.
      // Decide by hash, not by size/content-type heuristics.
      const rawHash = await this.#md5(tempDownload);
      let selectedPath = tempDownload;
      let selectedHash = rawHash;

      if (rawHash !== expectedHash) {
        let gunzipError = null;
        try {
          await pipeline(
            fs.createReadStream(tempDownload),
            zlib.createGunzip(),
            fs.createWriteStream(tempResult)
          );
        } catch (error) {
          gunzipError = error;
        }

        if (!gunzipError) {
          const unpackedHash = await this.#md5(tempResult);
          if (unpackedHash === expectedHash) {
            selectedPath = tempResult;
            selectedHash = unpackedHash;
          } else {
            throw new Error(
              `Checksum mismatch for ${action.relativePath}: expected ${expectedHash}, raw ${rawHash}, unpacked ${unpackedHash}`
            );
          }
        } else {
          throw new Error(
            `Checksum mismatch for ${action.relativePath}: expected ${expectedHash}, raw ${rawHash}, gunzip failed: ${gunzipError.message}`
          );
        }
      }

      if (selectedHash !== expectedHash) {
        throw new Error(
          `Checksum mismatch for ${action.relativePath}: expected ${expectedHash}, got ${selectedHash}`
        );
      }

      if (isCancelled()) {
        throw createInstallAbortError();
      }

      await fsp.mkdir(path.dirname(action.targetPath), { recursive: true });
      await fsp.copyFile(selectedPath, action.targetPath);
    } finally {
      // Clean up temp files (ignore errors if files don't exist)
      const cleanupResults = await Promise.allSettled([
        fsp.unlink(tempDownload).catch(() => {}),
        fsp.unlink(tempResult).catch(() => {})
      ]);

      // Log any unexpected cleanup failures
      cleanupResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const file = index === 0 ? tempDownload : tempResult;
          this.logger.warn('Temp file cleanup failed', { file, error: result.reason?.message });
        }
      });
    }
  }

  async installPlan(profile, planId, onProgress, installControl = {}) {
    const logger = this.logger.withCorrelation('install');
    logger.info('Starting installation', { planId, profileName: profile.name });

    const plan = this.planCache.get(planId);
    if (!plan) {
      logger.error('Plan not found in cache', { planId });
      throw new Error('Update plan not found. Run update check first.');
    }

    if (profile.id !== plan.profileId) {
      logger.error('Plan profile mismatch', { planId, planProfileId: plan.profileId, requestedProfileId: profile.id });
      throw new Error('Plan does not belong to the selected profile.');
    }

    const actions = plan.actions;
    const installSnapshot = await this.#createInstallSnapshot(profile, planId, plan);
    logger.info('Snapshot ready for installation', {
      planId,
      snapshotId: installSnapshot.snapshotId,
      actionCount: actions.length
    });

    let updated = 0;
    let deleted = 0;
    const isCancelled = () =>
      Boolean(installControl.isCancelled && installControl.isCancelled())
      || Boolean(installControl.signal && installControl.signal.aborted);
    const isPaused = () => Boolean(installControl.isPaused && installControl.isPaused());
    const waitUntilResumed = async () => {
      while (isPaused()) {
        if (isCancelled()) {
          throw createInstallAbortError();
        }
        await sleep(180);
      }
    };

    const startTime = Date.now();

    for (let index = 0; index < actions.length; index += 1) {
      if (isCancelled()) {
        logger.warn('Installation cancelled by user', { completed: index, total: actions.length });
        throw createInstallAbortError();
      }

      await waitUntilResumed();
      const action = actions[index];
      if (onProgress) {
        onProgress({
          index: index + 1,
          total: actions.length,
          type: action.type,
          packageName: action.packageName,
          path: action.relativePath,
          message: `${action.type.toUpperCase()} ${action.relativePath}`
        });
      }

      if (action.type === 'delete') {
        await this.#removeFileAndEmptyParents(action.targetPath, action.packageDir);
        deleted += 1;
        continue;
      }

      await this.#installUpdateAction(action, plan, installControl);
      updated += 1;
    }

    this.planCache.delete(planId);
    const duration = Date.now() - startTime;

    logger.info('Installation completed', {
      planId,
      updated,
      deleted,
      total: actions.length,
      durationSeconds: (duration / 1000).toFixed(1)
    });

    return {
      updated,
      deleted,
      total: actions.length,
      snapshotId: installSnapshot.snapshotId,
      snapshotType: plan.summary.snapshotType,
      snapshotNumber: plan.summary.snapshotNumber,
      completedAt: new Date().toISOString()
    };
  }
}

module.exports = {
  UpdateClient,
  UpdateHttpError
};
