const { createLogger } = require('./logger');

class IniBuildsClient {
  constructor(options = {}) {
    this.tempDir = options.tempDir || '';
    this.snapshotDir = options.snapshotDir || '';
    this.logger = createLogger('inibuilds-client');
  }

  #buildNotImplementedError(action) {
    const text = String(action || 'operation').trim() || 'operation';
    return new Error(
      `iniBuilds native integration is not implemented yet (${text}). `
      + 'Provider contract is in place; API/auth/plan/install logic will be added in upcoming v2 steps.'
    );
  }

  async createUpdatePlan(_profile, _options = {}) {
    this.logger.info('createUpdatePlan requested but not implemented yet');
    throw this.#buildNotImplementedError('createUpdatePlan');
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
