"use strict";

/**
 * In-memory implementation of the gateway's storage interface.
 * Local development and tests only; never deployed.
 */

function createMemoryStore() {
  const tenants = new Map();
  const tokens = new Map();
  const jobs = new Map();
  const keyIdsByValue = new Map();
  const queue = [];
  let keySequence = 0;

  return {
    queue,
    keyIdsByValue,
    async getSecret() {
      return { clientId: "test-client", clientSecret: "test-secret" };
    },
    async getTenant(apiKeyId) {
      return tenants.get(apiKeyId) || null;
    },
    async putTenant(tenant) {
      tenants.set(tenant.apiKeyId, tenant);
    },
    async getToken(encompassUserId) {
      return tokens.get(encompassUserId) || null;
    },
    async putToken(token) {
      tokens.set(token.encompassUserId, token);
    },
    async getJob(jobId) {
      return jobs.get(jobId) || null;
    },
    async putJob(job) {
      jobs.set(job.jobId, job);
    },
    async enqueueWrite(message) {
      queue.push({ ...message, receives: 0 });
    },
    async createApiKey({ tenantName }) {
      keySequence += 1;
      const id = `key-${keySequence}`;
      const value = `local-key-${keySequence}-${Math.random().toString(36).slice(2, 10)}`;
      keyIdsByValue.set(value, id);
      return { id, value, tenantName };
    },
  };
}

module.exports = { createMemoryStore };
