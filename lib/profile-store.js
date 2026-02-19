const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AtomicFile } = require('./atomic-file');
const { createLogger } = require('./logger');

const DEFAULT_HOST = 'https://update.x-plane.org';
const SECRET_SCHEME = 'safeStorage.v1';
const CHANNELS = new Set(['release', 'beta', 'alpha']);

function nowIso() {
  return new Date().toISOString();
}

function normalizeChannel(value) {
  const channel = String(value || '').trim().toLowerCase();
  return CHANNELS.has(channel) ? channel : 'release';
}

function normalizeIgnoreList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/\r?\n/g);

  const out = [];
  const seen = new Set();

  for (const rawEntry of source) {
    const normalized = String(rawEntry || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/');

    if (!normalized || normalized.startsWith('#')) {
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

class ProfileStore {
  constructor(baseDir, options = {}) {
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, 'profiles.json');
    this.encryptString = typeof options.encryptString === 'function' ? options.encryptString : null;
    this.decryptString = typeof options.decryptString === 'function' ? options.decryptString : null;
    this.logger = createLogger('profile-store');

    // Synchronous initialization (required for constructor)
    fs.mkdirSync(this.baseDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      // Initial write must be sync in constructor
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, profiles: [] }, null, 2), 'utf8');
    }
  }

  async #readProfileDatabase() {
    try {
      const data = await AtomicFile.readJSON(this.filePath);
      if (!data || !Array.isArray(data.profiles)) {
        this.logger.warn('Invalid profile database structure, returning defaults');
        return { version: 1, profiles: [] };
      }
      return data;
    } catch (error) {
      this.logger.error('Failed to read profile database', { error: error.message });
      throw new Error(`Failed to read profiles: ${error.message}`);
    }
  }

  async #writeProfileDatabase(data) {
    try {
      await AtomicFile.writeJSON(this.filePath, data);
      this.logger.debug('Profile database written successfully');
    } catch (error) {
      this.logger.error('Failed to write profile database', { error: error.message });
      throw new Error(`Failed to save profiles: ${error.message}`);
    }
  }

  #encodeSecret(value) {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }

    if (!this.encryptString) {
      this.logger.warn('Encryption unavailable, storing credential as plaintext');
      return text;
    }

    try {
      const encrypted = this.encryptString(text);
      return {
        scheme: SECRET_SCHEME,
        data: encrypted
      };
    } catch (error) {
      this.logger.error('Credential encryption failed, falling back to plaintext', { 
        error: error.message 
      });
      return text;
    }
  }

  #decodeSecret(value) {
    if (typeof value === 'string') {
      return value;
    }

    if (!value || typeof value !== 'object') {
      return '';
    }

    if (value.scheme !== SECRET_SCHEME || typeof value.data !== 'string') {
      this.logger.warn('Unknown credential storage scheme detected');
      return '';
    }

    if (!this.decryptString) {
      this.logger.error('Decryption function unavailable for encrypted credential');
      return '';
    }

    try {
      return this.decryptString(value.data);
    } catch (error) {
      this.logger.error('Credential decryption failed', { 
        error: error.message,
        scheme: value.scheme 
      });
      return '';
    }
  }

  #isEncryptedSecret(value) {
    return Boolean(
      value
      && typeof value === 'object'
      && value.scheme === SECRET_SCHEME
      && typeof value.data === 'string'
    );
  }

  #toPublicProfile(storedProfile) {
    const rememberAuth = Boolean(storedProfile.rememberAuth);
    const channel = normalizeChannel(storedProfile.channel);
    const ignoreList = normalizeIgnoreList(storedProfile.ignoreList);

    const login = rememberAuth ? this.#decodeSecret(storedProfile.login) : '';
    const licenseKey = rememberAuth ? this.#decodeSecret(storedProfile.licenseKey) : '';
    const loginUnavailable = rememberAuth && this.#isEncryptedSecret(storedProfile.login) && !login;
    const licenseKeyUnavailable = rememberAuth && this.#isEncryptedSecret(storedProfile.licenseKey) && !licenseKey;

    return {
      ...storedProfile,
      channel,
      ignoreList,
      login,
      licenseKey,
      loginUnavailable,
      licenseKeyUnavailable,
      credentialsUnavailable: loginUnavailable || licenseKeyUnavailable
    };
  }

  #normalizeAndEncodeProfile(inputProfile, now) {
    const rememberAuth = Boolean(inputProfile.rememberAuth);
    const normalized = {
      id: inputProfile.id || crypto.randomUUID(),
      name: String(inputProfile.name).trim(),
      host: String(inputProfile.host || DEFAULT_HOST).trim().replace(/\/$/, ''),
      productDir: String(inputProfile.productDir).trim(),
      login: rememberAuth ? this.#encodeSecret(inputProfile.login) : '',
      licenseKey: rememberAuth ? this.#encodeSecret(inputProfile.licenseKey) : '',
      packageVersion: Number.isFinite(Number(inputProfile.packageVersion))
        ? Number(inputProfile.packageVersion)
        : 0,
      rememberAuth,
      channel: normalizeChannel(inputProfile.channel),
      ignoreList: normalizeIgnoreList(inputProfile.ignoreList),
      createdAt: inputProfile.createdAt || now,
      updatedAt: now
    };

    return normalized;
  }

  async listProfiles() {
    const db = await this.#readProfileDatabase();
    return db.profiles.map((profile) => this.#toPublicProfile(profile));
  }

  async getProfile(profileId) {
    const db = await this.#readProfileDatabase();
    const profile = db.profiles.find((p) => p.id === profileId);
    return profile ? this.#toPublicProfile(profile) : null;
  }

  async saveProfile(inputProfile) {
    if (!inputProfile || typeof inputProfile !== 'object') {
      throw new Error('Invalid profile payload.');
    }

    if (!inputProfile.name || !inputProfile.productDir) {
      throw new Error('Profile requires: name, productDir.');
    }

    const rememberAuth = Boolean(inputProfile.rememberAuth);
    if (
      rememberAuth
      && (!String(inputProfile.login || '').trim() || !String(inputProfile.licenseKey || '').trim())
    ) {
      throw new Error('Profile requires login and licenseKey when credentials are stored.');
    }

    const db = await this.#readProfileDatabase();
    const now = nowIso();

    const normalized = this.#normalizeAndEncodeProfile(inputProfile, now);
    const existingIndex = db.profiles.findIndex((p) => p.id === normalized.id);
    if (existingIndex >= 0) {
      normalized.createdAt = db.profiles[existingIndex].createdAt || now;
      db.profiles[existingIndex] = normalized;
      this.logger.info('Profile updated', { profileId: normalized.id, profileName: normalized.name });
    } else {
      db.profiles.push(normalized);
      this.logger.info('Profile created', { profileId: normalized.id, profileName: normalized.name });
    }

    await this.#writeProfileDatabase(db);
    return this.#toPublicProfile(normalized);
  }

  async setPackageVersion(profileId, packageVersion) {
    const db = await this.#readProfileDatabase();
    const existingIndex = db.profiles.findIndex((p) => p.id === profileId);
    if (existingIndex < 0) {
      this.logger.warn('Attempted to set package version for non-existent profile', { profileId });
      return null;
    }

    const parsed = Number(packageVersion);
    const normalizedVersion = Number.isFinite(parsed) && parsed >= 0
      ? Math.trunc(parsed)
      : db.profiles[existingIndex].packageVersion || 0;

    db.profiles[existingIndex].packageVersion = normalizedVersion;
    db.profiles[existingIndex].updatedAt = nowIso();
    
    this.logger.info('Package version updated', { 
      profileId, 
      packageVersion: normalizedVersion 
    });

    await this.#writeProfileDatabase(db);

    return this.#toPublicProfile(db.profiles[existingIndex]);
  }

  async deleteProfile(profileId) {
    const db = await this.#readProfileDatabase();
    const originalCount = db.profiles.length;
    db.profiles = db.profiles.filter((p) => p.id !== profileId);
    
    if (db.profiles.length < originalCount) {
      this.logger.info('Profile deleted', { profileId });
      await this.#writeProfileDatabase(db);
    } else {
      this.logger.warn('Attempted to delete non-existent profile', { profileId });
    }
  }
}

module.exports = {
  ProfileStore
};
