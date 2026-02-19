const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Atomic file write utility to prevent corruption from concurrent writes.
 * Uses temp file + rename pattern for atomicity.
 */
class AtomicFile {
  /**
   * Atomically write data to a file.
   * @param {string} filePath - Target file path
   * @param {string} data - Data to write
   * @param {object} options - Write options
   * @returns {Promise<void>}
   */
  static async write(filePath, data, options = {}) {
    const encoding = options.encoding || 'utf8';
    const tempSuffix = crypto.randomBytes(4).toString('hex');
    const tempPath = `${filePath}.tmp-${tempSuffix}`;

    try {
      // Write to temp file first
      await fsp.writeFile(tempPath, data, { encoding });

      // Atomic rename (overwrites target if it exists)
      await fsp.rename(tempPath, filePath);
    } catch (error) {
      // Clean up temp file on failure
      try {
        await fsp.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Safely read and parse JSON file.
   * @param {string} filePath - File path to read
   * @returns {Promise<any>} Parsed JSON object
   * @throws {Error} If file doesn't exist or JSON is invalid
   */
  static async readJSON(filePath) {
    const raw = await fsp.readFile(filePath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in ${path.basename(filePath)}: ${error.message}`);
    }
  }

  /**
   * Atomically write JSON to file with formatting.
   * @param {string} filePath - Target file path
   * @param {any} data - Object to serialize
   * @returns {Promise<void>}
   */
  static async writeJSON(filePath, data) {
    const json = JSON.stringify(data, null, 2);
    await this.write(filePath, json, { encoding: 'utf8' });
  }
}

module.exports = { AtomicFile };
