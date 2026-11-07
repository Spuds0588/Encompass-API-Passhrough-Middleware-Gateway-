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
  const apiKeys = new Map();
  const provisioning = new Map();
  const queue = [];
  let keySequence = 0;

  return {
    queue,
    keyIdsByValue,
    apiKeys,
    provisioning,
    async getSecret() {
      return { clientId: "test-client", clientSecret: "test-secret" };
    },
    async getTenant(apiKeyId) {
      return tenants.get(apiKeyId) || null;
    },
    async putTenant(tenant) {
      tenants.set(tenant.apiKeyId, tenant);
    },
    async claimProvisioning(item) {
      if (provisioning.has(item.provisioningKey)) return false;
      provisioning.set(item.provisioningKey, { ...item });
      return true;
    },
    async getProvisioning(provisioningKey) {
      return provisioning.get(provisioningKey) || null;
    },
    async putProvisioning(item) {
      provisioning.set(item.provisioningKey, { ...item });
    },
    async deleteProvisioning(provisioningKey) {
      provisioning.delete(provisioningKey);
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
    async getApiKey(apiKeyId) {
      return apiKeys.get(apiKeyId) || null;
    },
    async deleteApiKey(apiKeyId) {
      const key = apiKeys.get(apiKeyId);
      if (key) keyIdsByValue.delete(key.value);
      apiKeys.delete(apiKeyId);
    },
    async createApiKey({ tenantName }) {
      keySequence += 1;
      const id = `key-${keySequence}`;
      const value = `local-key-${keySequence}-${Math.random().toString(36).slice(2, 10)}`;
      apiKeys.set(id, { id, value, tenantName, enabled: true });
      keyIdsByValue.set(value, id);
      return { id, value, tenantName };
    },
  };
}

module.exports = { createMemoryStore };
