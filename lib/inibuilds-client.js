const { createLogger } = require('./logger');

class IniBuildsClient {
  constructor(options = {}) {
    this.tempDir = options.tempDir || '';
    this.snapshotDir = options.snapshotDir || '';
    this.baseUrl = String(options.baseUrl || '').trim();
    this.authPath = String(options.authPath || '/api/auth/login').trim() || '/api/auth/login';
    this.productsPath = String(options.productsPath || '/api/products').trim() || '/api/products';
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(2000, Math.trunc(Number(options.timeoutMs)))
      : 15000;
    this.logger = createLogger('inibuilds-client');
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

  #extractProducts(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (!payload || typeof payload !== 'object') {
      return [];
    }

    if (Array.isArray(payload.products)) {
      return payload.products;
    }

    if (Array.isArray(payload.items)) {
      return payload.items;
    }

    if (Array.isArray(payload.data)) {
      return payload.data;
    }

    if (Array.isArray(payload.result)) {
      return payload.result;
    }

    return [];
  }

  async #authenticate(baseUrl, profile) {
    const login = String(profile && profile.login ? profile.login : '').trim();
    const secret = String(profile && profile.licenseKey ? profile.licenseKey : '').trim();

    if (!login || !secret) {
      throw new Error('iniBuilds credentials are missing (login/license key).');
    }

    const authUrl = this.#joinUrl(baseUrl, this.authPath);
    const payloadCandidates = [
      { email: login, password: secret },
      { login, password: secret },
      { username: login, password: secret },
      { email: login, licenseKey: secret }
    ];

    let lastError = '';
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
        lastError = `HTTP ${result.status}`;
        continue;
      }

      const token = this.#extractToken(result.data);
      if (token) {
        return token;
      }

      lastError = 'No access token returned by auth endpoint.';
    }

    throw new Error(`iniBuilds authentication failed (${lastError || 'unknown error'}).`);
  }

  #buildNotImplementedError(action) {
    const text = String(action || 'operation').trim() || 'operation';
    return new Error(
      `iniBuilds native integration is not implemented yet (${text}). `
      + 'Provider contract is in place; API/auth/plan/install logic will be added in upcoming v2 steps.'
    );
  }

  async createUpdatePlan(profile, _options = {}) {
    const baseUrl = this.#normalizeBaseUrl(profile);
    this.logger.info('Starting iniBuilds API probe (auth + products)', {
      baseUrl,
      authPath: this.authPath,
      productsPath: this.productsPath
    });

    const token = await this.#authenticate(baseUrl, profile);
    const productsUrl = this.#joinUrl(baseUrl, this.productsPath);
    const productsResult = await this.#requestJson(productsUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'AeroSync-Addon-Updater'
      }
    });

    if (!productsResult.ok) {
      throw new Error(`iniBuilds product list request failed (HTTP ${productsResult.status}).`);
    }

    const products = this.#extractProducts(productsResult.data);
    const productCount = products.length;
    const now = Date.now();

    this.logger.info('iniBuilds API probe successful', { productCount });

    return {
      planId: `inibuilds-probe-${now}`,
      summary: {
        snapshotType: 'inibuilds',
        snapshotNumber: 0,
        fileCount: 0,
        deleteCount: 0,
        downloadSize: 0,
        downloadSizeKnown: 0,
        downloadSizeEstimatedMax: 0,
        downloadSizeUnknownCount: 0,
        diskSize: 0,
        ignoredCount: 0,
        optionalIgnoredCount: 0,
        optionalForcedInstallCount: 0
      },
      actions: [],
      warnings: [
        `iniBuilds API connection successful (${productCount} product(s) discovered).`,
        'Native file planning/install is not implemented yet for iniBuilds. This is an API integration checkpoint.'
      ],
      optionalPackages: []
    };
  }

  async installPlan(_profile, _planId, _onProgress, _runtimeControl = {}) {
    this.logger.info('installPlan requested but not implemented yet');
    throw this.#buildNotImplementedError('installPlan');
  }

  async getRollbackInfo(_profileId) {
    this.logger.info('getRollbackInfo requested (returns unavailable while integration is in progress)');
    return {
      available: false,
      reason: 'iniBuilds provider rollback is not implemented yet.'
    };
  }

  async rollbackLatestSnapshot(_profile) {
    this.logger.info('rollbackLatestSnapshot requested but not implemented yet');
    throw this.#buildNotImplementedError('rollbackLatestSnapshot');
  }
}

module.exports = {
  IniBuildsClient
};
