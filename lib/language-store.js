const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function normalizeCode(inputCode) {
  return String(inputCode || '').trim().toLowerCase();
}

class LanguageStore {
  constructor(baseDir) {
    this.baseDir = path.resolve(baseDir);
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  getDirectory() {
    return this.baseDir;
  }

  async #readLanguageFile(filePath) {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const meta = parsed && typeof parsed === 'object' ? parsed.meta : null;
    const messages = parsed && typeof parsed === 'object' ? parsed.messages : null;

    if (!meta || typeof meta !== 'object') {
      throw new Error(`Invalid language file "${filePath}": missing meta object.`);
    }

    if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
      throw new Error(`Invalid language file "${filePath}": missing messages object.`);
    }

    const code = normalizeCode(meta.code);
    const name = String(meta.name || '').trim();
    const locale = String(meta.locale || code || '').trim();

    if (!code || !name) {
      throw new Error(`Invalid language file "${filePath}": meta.code/meta.name required.`);
    }

    return {
      code,
      name,
      locale: locale || code,
      fileName: path.basename(filePath),
      filePath,
      messages
    };
  }

  async #readAllLanguages() {
    const entries = await fsp.readdir(this.baseDir, { withFileTypes: true });
    const out = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!entry.name.toLowerCase().endsWith('.json')) {
        continue;
      }

      const filePath = path.join(this.baseDir, entry.name);
      try {
        const language = await this.#readLanguageFile(filePath);
        out.push(language);
      } catch {
        // Ignore broken files, users can fix JSON and reload.
      }
    }

    out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return out;
  }

  async listLanguages() {
    const all = await this.#readAllLanguages();
    return all.map((item) => ({
      code: item.code,
      name: item.name,
      locale: item.locale
    }));
  }

  async loadLanguage(requestedCode) {
    const all = await this.#readAllLanguages();
    if (all.length === 0) {
      throw new Error(`No language files found in ${this.baseDir}`);
    }

    const fallback = all.find((item) => item.code === 'en')
      || all.find((item) => item.code === 'de')
      || all[0];

    const requested = normalizeCode(requestedCode);
    const selected = all.find((item) => item.code === requested) || fallback;

    return {
      code: selected.code,
      name: selected.name,
      locale: selected.locale,
      messages: {
        ...fallback.messages,
        ...selected.messages
      }
    };
  }
}

module.exports = {
  LanguageStore
};
