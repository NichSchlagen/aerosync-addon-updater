const util = require('node:util');
const crypto = require('node:crypto');

const LOG_LEVELS = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
});

const LOG_LEVEL_NAMES = Object.freeze({
  [LOG_LEVELS.DEBUG]: 'DEBUG',
  [LOG_LEVELS.INFO]: 'INFO',
  [LOG_LEVELS.WARN]: 'WARN',
  [LOG_LEVELS.ERROR]: 'ERROR'
});

class Logger {
  constructor(options = {}) {
    this.context = options.context || 'app';
    this.minLevel = LOG_LEVELS[options.minLevel] ?? LOG_LEVELS.INFO;
    this.correlationId = options.correlationId || null;
  }

  #formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const levelName = LOG_LEVEL_NAMES[level] || 'INFO';
    const ctx = this.context;
    const corrId = meta.correlationId || this.correlationId;

    const parts = [
      `[${timestamp}]`,
      `[${levelName}]`,
      `[${ctx}]`
    ];

    if (corrId) {
      parts.push(`[${corrId}]`);
    }

    parts.push(message);

    if (Object.keys(meta).length > 0) {
      const sanitized = this.#sanitizeMeta(meta);
      parts.push(util.inspect(sanitized, { depth: 3, colors: false }));
    }

    return parts.join(' ');
  }

  #sanitizeMeta(meta) {
    if (!meta || typeof meta !== 'object') {
      return {};
    }

    const out = {};
    for (const [key, value] of Object.entries(meta)) {
      if (this.#isSensitiveKey(key)) {
        out[key] = '[REDACTED]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = this.#sanitizeMeta(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  #isSensitiveKey(key) {
    return /password|token|secret|license|login|credential|auth|key/i.test(String(key || ''));
  }

  #log(level, message, meta = {}) {
    if (level < this.minLevel) {
      return;
    }

    const formatted = this.#formatMessage(level, message, meta);

    if (level >= LOG_LEVELS.ERROR) {
      console.error(formatted);
    } else if (level >= LOG_LEVELS.WARN) {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  debug(message, meta) {
    this.#log(LOG_LEVELS.DEBUG, message, meta);
  }

  info(message, meta) {
    this.#log(LOG_LEVELS.INFO, message, meta);
  }

  warn(message, meta) {
    this.#log(LOG_LEVELS.WARN, message, meta);
  }

  error(message, meta) {
    this.#log(LOG_LEVELS.ERROR, message, meta);
  }

  child(context, options = {}) {
    return new Logger({
      context: `${this.context}:${context}`,
      minLevel: LOG_LEVEL_NAMES[this.minLevel],
      correlationId: options.correlationId || this.correlationId
    });
  }

  withCorrelation(operationName = 'op') {
    const correlationId = `${operationName}-${crypto.randomBytes(4).toString('hex')}`;
    return new Logger({
      context: this.context,
      minLevel: LOG_LEVEL_NAMES[this.minLevel],
      correlationId
    });
  }
}

function createLogger(context, options = {}) {
  return new Logger({ context, ...options });
}

module.exports = {
  Logger,
  createLogger,
  LOG_LEVELS
};
