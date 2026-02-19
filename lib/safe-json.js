/**
 * Safe JSON parsing utilities with proper error handling
 */

/**
 * Safely parse JSON string without throwing
 * @param {string} text - JSON string to parse
 * @param {any} fallback - Value to return on parse failure (default: null)
 * @returns {any} Parsed object or fallback value
 */
function parseJsonSafe(text, fallback = null) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Safely parse JSON string with error callback
 * @param {string} text - JSON string to parse
 * @param {function} onError - Callback to handle parse errors
 * @returns {any} Parsed object or result of onError callback
 */
function parseJsonWithHandler(text, onError) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return onError ? onError(new Error('Empty or invalid JSON text')) : null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return onError ? onError(error) : null;
  }
}

/**
 * Safely stringify JSON with fallback
 * @param {any} value - Value to stringify
 * @param {string|null} fallback - Value to return on stringify failure (default: '{}')
 * @param {number} space - Spaces for indentation (default: 0)
 * @returns {string} JSON string or fallback
 */
function stringifyJsonSafe(value, fallback = '{}', space = 0) {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return fallback;
  }
}

/**
 * Validate that value is a non-empty object (not array, not null)
 * @param {any} value - Value to check
 * @returns {boolean}
 */
function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Validate that value is a non-empty array
 * @param {any} value - Value to check
 * @returns {boolean}
 */
function isNonEmptyArray(value) {
  return Boolean(Array.isArray(value) && value.length > 0);
}

/**
 * Get value from object at path with fallback
 * @param {object} obj - Object to query
 * @param {string} path - Dot-separated path (e.g., 'user.profile.name')
 * @param {any} fallback - Fallback value if path not found
 * @returns {any}
 */
function getPath(obj, path, fallback = undefined) {
  if (!isObject(obj) || !path) {
    return fallback;
  }

  const keys = String(path).split('.');
  let current = obj;

  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return fallback;
    }
    current = current[key];
  }

  return current === undefined ? fallback : current;
}

module.exports = {
  parseJsonSafe,
  parseJsonWithHandler,
  stringifyJsonSafe,
  isObject,
  isNonEmptyArray,
  getPath
};
