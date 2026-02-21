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

module.exports = {
  parseJsonSafe
};
