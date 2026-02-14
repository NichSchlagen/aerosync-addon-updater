const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

    fs.mkdirSync(this.baseDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.#write({ version: 1, profiles: [] });
    }
  }

  #read() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) {
      return { version: 1, profiles: [] };
    }

    return parsed;
  }

  #write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  #encodeSecret(value) {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }

    if (!this.encryptString) {
      return text;
    }

    try {
      return {
        scheme: SECRET_SCHEME,
        data: this.encryptString(text)
      };
    } catch {
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
      return '';
    }

    if (!this.decryptString) {
      return '';
    }

    try {
      return this.decryptString(value.data);
    } catch {
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

  listProfiles() {
    const db = this.#read();
    return db.profiles.map((profile) => this.#toPublicProfile(profile));
  }

  getProfile(profileId) {
    const db = this.#read();
    const profile = db.profiles.find((p) => p.id === profileId);
    return profile ? this.#toPublicProfile(profile) : null;
  }

  saveProfile(inputProfile) {
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

    const db = this.#read();
    const now = nowIso();

    const normalized = this.#normalizeAndEncodeProfile(inputProfile, now);
    const existingIndex = db.profiles.findIndex((p) => p.id === normalized.id);
    if (existingIndex >= 0) {
      normalized.createdAt = db.profiles[existingIndex].createdAt || now;
      db.profiles[existingIndex] = normalized;
    } else {
      db.profiles.push(normalized);
    }

    this.#write(db);
    return this.#toPublicProfile(normalized);
  }

  setPackageVersion(profileId, packageVersion) {
    const db = this.#read();
    const existingIndex = db.profiles.findIndex((p) => p.id === profileId);
    if (existingIndex < 0) {
      return null;
    }

    const parsed = Number(packageVersion);
    const normalizedVersion = Number.isFinite(parsed) && parsed >= 0
      ? Math.trunc(parsed)
      : db.profiles[existingIndex].packageVersion || 0;

    db.profiles[existingIndex].packageVersion = normalizedVersion;
    db.profiles[existingIndex].updatedAt = nowIso();
    this.#write(db);

    return this.#toPublicProfile(db.profiles[existingIndex]);
  }

  deleteProfile(profileId) {
    const db = this.#read();
    db.profiles = db.profiles.filter((p) => p.id !== profileId);
    this.#write(db);
  }
}

module.exports = {
  ProfileStore
};
