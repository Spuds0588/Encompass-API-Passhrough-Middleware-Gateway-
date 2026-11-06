"use strict";

/**
 * Encompass API Passthrough & Middleware Gateway - single Lambda handler.
 *
 * Handles both API Gateway proxy events (admin portal, field-filtered reads,
 * async write enqueue, job status) and SQS FIFO write events.
 *
 * Runtime: Node.js 24.x. No runtime dependencies beyond the AWS SDK v3 that
 * ships with the Lambda runtime, so it can be embedded as CloudFormation
 * inline code (ZipFile).
 */

const { randomUUID, timingSafeEqual } = require("node:crypto");

const DEFAULT_FIELDS = "11,12,14,1109";
const MAX_FIELDS = 100;
const TOKEN_SKEW_SECONDS = 300;
const READ_CACHE_TTL_MS = 30_000;
const READ_CACHE_MAX_ENTRIES = 500;
const MAX_ATTEMPTS = 5;
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;
const FIELD_ID = /^[A-Za-z0-9._]+$/;
const CONDITION_ID = /^[A-Za-z0-9._:-]+$/;
const MAX_CONDITION_UPDATES = 20;
const MAX_BODY_BYTES = 10_000;
const DOCUMENT_QUERY_KEYS = ["requireActiveAttachments", "includeRemoved", "view", "start", "limit"];
const CONDITION_QUERY_KEYS = ["conditionType", "includeRemoved", "view", "start", "limit"];
const SCHEMA_CACHE_TTL_MS = 5 * 60_000;
const SCHEMA_CACHE_MAX_ENTRIES = 200;
const STANDARD_FIELDS_PATH = "/encompass/v3/schemas/loan/standardFields";
const CUSTOM_FIELDS_PATH = "/encompass/v3/settings/loan/customFields";

const ROLE_CONFIG = {
  title: { label: "Title / Settlement", codeEnv: "INVITE_TITLE", personaEnv: "PERSONA_TITLE" },
  broker: { label: "TPO / Broker", codeEnv: "INVITE_BROKER", personaEnv: "PERSONA_BROKER" },
  appraisal: { label: "AMC / Appraisal", codeEnv: "INVITE_APPRAISAL", personaEnv: "PERSONA_APPRAISAL" },
};

// Curated cheat sheet for the portal. The dynamic schema route is the source
// of truth for everything else, including CX.* custom fields.
const FIELD_CATALOG = [
  { category: "Property", name: "Street Address", id: "11", type: "STRING", sample: '"123 Main St"' },
  { category: "Property", name: "City", id: "12", type: "STRING", sample: '"Irvine"' },
  { category: "Property", name: "State", id: "14", type: "STRING", sample: '"CA"' },
  { category: "Property", name: "Zip", id: "15", type: "STRING", sample: '"92618"' },
  { category: "Loan Terms", name: "Loan Amount", id: "1109", type: "DECIMAL", sample: "450000.00" },
  { category: "Loan Terms", name: "Interest Rate", id: "3", type: "DECIMAL", sample: "6.875" },
  { category: "Milestones", name: "Estimated Closing Date", id: "763", type: "DATE", sample: '"11/20/2026"' },
  { category: "Milestones", name: "Active Milestone", id: "1393", type: "STRING", sample: '"Underwriting"' },
  { category: "Title Fees", name: "Lender's Title Insurance", id: "646", type: "DECIMAL", sample: "1250.00" },
  { category: "Title Fees", name: "Owner's Title Insurance", id: "647", type: "DECIMAL", sample: "450.00" },
  { category: "Title Fees", name: "Settlement / Escrow Fee", id: "648", type: "DECIMAL", sample: "600.00" },
];

// Per-container caches. Scoped by persona so tenants can never see another
// tenant's projection or schema results.
const readCache = new Map();
const fieldCache = new Map();

const log = (level, action, details = {}) =>
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, action, ...details }));

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  body: JSON.stringify(body),
});

const error = (statusCode, message, extra = {}) => json(statusCode, { error: message, ...extra });

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function header(event, name) {
  const headers = event.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseFields(raw) {
  const fields = String(raw || DEFAULT_FIELDS)
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const unique = [...new Set(fields)];
  if (unique.length === 0 || unique.length > MAX_FIELDS) return null;
  if (unique.some((field) => !FIELD_ID.test(field))) return null;
  return unique;
}

function validFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0 || keys.length > MAX_FIELDS) return false;
  return keys.every(
    (key) =>
      FIELD_ID.test(key) &&
      (["string", "number", "boolean"].includes(typeof fields[key]) || fields[key] === null),
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function parseIds(raw) {
  if (!raw) return null;
  const ids = String(raw).split(",").map((id) => id.trim()).filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > MAX_FIELDS) return null;
  if (unique.some((id) => !FIELD_ID.test(id))) return null;
  return unique;
}

const isCustomField = (id) => id.startsWith("CX.") || /^CUST\d{2}FV$/.test(id);

function collectDefinitions(entries, requested, target) {
  const wanted = new Set(requested);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String(entry.id ?? entry.fieldId ?? entry.fieldName ?? "");
    if (!wanted.has(id)) continue;
    const definition = {
      description: String(entry.description || ""),
      type: String(entry.format || entry.dataType || entry.type || "STRING").toUpperCase(),
    };
    if (typeof entry.readOnly === "boolean") definition.readOnly = entry.readOnly;
    if (typeof entry.fieldLock === "boolean") definition.fieldLock = entry.fieldLock;
    target[id] = definition;
  }
}

function roleFor(env, role) {
  const config = ROLE_CONFIG[role];
  if (!config) return null;
  const code = env[config.codeEnv];
  const persona = env[config.personaEnv];
  return code && persona ? { role, label: config.label, code, persona } : null;
}

function pickQuery(params, allowed) {
  const picked = {};
  for (const key of allowed) {
    const value = params && params[key];
    if (value === undefined || value === null || value === "") continue;
    if (!/^[A-Za-z0-9._-]{1,50}$/.test(String(value))) return null;
    picked[key] = String(value);
  }
  return picked;
}

// Only the fields the officially verified CreateAttachment contract accepts.
function validUpload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const file = payload.file;
  if (!file || typeof file !== "object" || Array.isArray(file)) return null;
  const name = typeof file.name === "string" ? file.name.trim() : "";
  const contentType = typeof file.contentType === "string" ? file.contentType.trim() : "";
  const size = Number(file.size);
  if (!name || name.length > 255) return null;
  if (!contentType || contentType.length > 100 || !contentType.includes("/")) return null;
  if (!Number.isFinite(size) || size < 0 || size > 1_000_000_000) return null;
  const upload = { file: { contentType, name, size } };
  if (payload.title !== undefined) {
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (!title || title.length > 255) return null;
    upload.title = title;
  }
  if (payload.assignTo !== undefined) {
    const assignTo = payload.assignTo;
    if (!assignTo || typeof assignTo !== "object" || Array.isArray(assignTo)) return null;
    const entityId = typeof assignTo.entityId === "string" ? assignTo.entityId.trim() : "";
    if (!entityId || entityId.length > 100 || assignTo.entityType !== "Document") return null;
    upload.assignTo = { entityId, entityType: "Document" };
  }
  return upload;
}

// Optional per-role write allowlist. Unset means any valid field ID; malformed
// configuration fails closed so a typo cannot silently widen a role.
function writeAllowlist(env, role) {
  const raw = env[`WRITE_FIELDS_${String(role || "").toUpperCase()}`];
  if (raw === undefined || raw === "") return null;
  const ids = String(raw).split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !FIELD_ID.test(id))) return new Set();
  return new Set(ids);
}

const html = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  },
  body,
});

function createHandler({ store, fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) {
  if (!store) throw new Error("createHandler requires a store");

  const baseUrl = () => (env.ENCOMPASS_BASE_URL || "https://api.elliemae.com").replace(/\/+$/, "");
  const timeoutMs = () => Number(env.UPSTREAM_TIMEOUT_MS) || 8000;
  let credentials = null;

  async function credentialsForExchange() {
    if (!credentials) credentials = await store.getSecret();
    return credentials;
  }

  async function getScopedToken(encompassUserId) {
    const nowSeconds = Math.floor(now() / 1000);
    const cached = await store.getToken(encompassUserId);
    if (cached && cached.accessToken && cached.expiresAt > nowSeconds + TOKEN_SKEW_SECONDS) {
      log("INFO", "TOKEN_CACHE_HIT", { encompassUserId });
      return cached.accessToken;
    }

    log("INFO", "TOKEN_EXCHANGE_REQUEST", { encompassUserId });
    const secret = await credentialsForExchange();
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: secret.clientId,
      client_secret: secret.clientSecret,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_user_id: encompassUserId,
    });

    const response = await fetchImpl(`${baseUrl()}/oauth2/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs()),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      log("ERROR", "TOKEN_EXCHANGE_FAILED", { encompassUserId, status: response.status, detail });
      throw new Error(`Encompass auth failure: ${response.status}`);
    }

    const token = await response.json();
    const expiresAt = nowSeconds + (Number(token.expires_in) || 1800);
    await store.putToken({ encompassUserId, accessToken: token.access_token, expiresAt, ttl: expiresAt });
    log("INFO", "TOKEN_EXCHANGE_SUCCESS", { encompassUserId, expiresAt });
    return token.access_token;
  }

  async function tenantFor(apiKeyId) {
    if (!apiKeyId) return null;
    const tenant = await store.getTenant(apiKeyId);
    return tenant && tenant.status === "ACTIVE" ? tenant : null;
  }

  async function authorizedTenant(apiKeyId, action) {
    const tenant = await tenantFor(apiKeyId);
    if (!tenant) return { response: error(403, "Unauthorized tenant mapping") };
    try {
      return { tenant, token: await getScopedToken(tenant.encompassUserId) };
    } catch (err) {
      log("ERROR", "ENCOMPASS_AUTH_UNAVAILABLE", { action, message: err.message });
      return { response: error(502, "Encompass authentication failed") };
    }
  }

  async function callEncompass(token, path, { method = "GET", query = {}, body } = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) search.set(key, String(value));
    const suffix = search.toString() ? `?${search}` : "";
    const response = await fetchImpl(`${baseUrl()}${path}${suffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    const text = await response.text().catch(() => "");
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { response, body: parsed };
  }

  function upstreamFailure(result) {
    const status = result.response.status;
    if (status === 423) return error(423, "Loan is locked by Encompass", { code: "FILE_LOCKED" });
    if (status === 404) return error(404, "Encompass resource not found");
    if (status === 429) return error(429, "Encompass rate limit reached");
    if (status === 401 || status === 403) return error(502, "Encompass rejected gateway credentials");
    if (status >= 500) return error(502, "Encompass unavailable");
    return error(400, "Encompass rejected the request", { upstreamStatus: status });
  }

  async function callForLoan(event, apiKeyId, loanId, action, options) {
    const scoped = await authorizedTenant(apiKeyId, action);
    if (scoped.response) return { response: scoped.response };
    const { path: loanPath, ...request } = options;
    try {
      const result = await callEncompass(
        scoped.token,
        `/encompass/v3/loans/${encodeURIComponent(loanId)}${loanPath}`,
        request,
      );
      return { tenant: scoped.tenant, result };
    } catch (err) {
      log("ERROR", "ENCOMPASS_REQUEST_FAILED", { action, loanId, message: err.message });
      return { response: error(err.name === "TimeoutError" ? 504 : 502, "Encompass request failed") };
    }
  }

  async function fetchSchema(path, ids, token) {
    const url = `${baseUrl()}${path}?start=0&limit=10000&ids=${encodeURIComponent(ids.join(","))}`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`${path} returned ${response.status}: ${detail}`);
    }
    const body = await response.json();
    return Array.isArray(body) ? body : Array.isArray(body && body.fields) ? body.fields : [];
  }

  async function fieldDefinitions(event, apiKeyId) {
    const tenant = await tenantFor(apiKeyId);
    if (!tenant) return error(403, "Unauthorized tenant mapping");

    const ids = parseIds(event.queryStringParameters?.ids);
    if (!ids) return error(400, "ids is required (comma-separated, max 100)");

    const cacheKey = `${tenant.encompassUserId}|${ids.join(",")}`;
    const cached = fieldCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      log("INFO", "FIELD_SCHEMA_CACHE_HIT", { count: ids.length });
      return json(200, cached.body, { "Cache-Control": "private, max-age=300" });
    }

    let token;
    try {
      token = await getScopedToken(tenant.encompassUserId);
    } catch (err) {
      log("ERROR", "ENCOMPASS_AUTH_UNAVAILABLE", { path: "/v1/fields", message: err.message });
      return error(502, "Encompass authentication failed");
    }

    const standardIds = ids.filter((id) => !isCustomField(id));
    const customIds = ids.filter(isCustomField);
    const definitions = {};

    try {
      if (standardIds.length) {
        collectDefinitions(await fetchSchema(STANDARD_FIELDS_PATH, standardIds, token), standardIds, definitions);
      }
      if (customIds.length) {
        collectDefinitions(await fetchSchema(CUSTOM_FIELDS_PATH, customIds, token), customIds, definitions);
      }
    } catch (err) {
      log("ERROR", "FIELD_SCHEMA_FAILED", { message: err.message, ids: ids.length });
      return error(502, "Encompass field schema unavailable");
    }

    if (Object.keys(definitions).length === 0) return error(404, "No field definitions found");
    fieldCache.set(cacheKey, { body: definitions, expiresAt: now() + SCHEMA_CACHE_TTL_MS });
    if (fieldCache.size > SCHEMA_CACHE_MAX_ENTRIES) fieldCache.clear();
    log("INFO", "FIELD_SCHEMA_LOOKUP", { count: Object.keys(definitions).length, requested: ids.length });
    return json(200, definitions, { "Cache-Control": "private, max-age=300" });
  }

  async function readLoan(event, apiKeyId, loanId) {
    const tenant = await tenantFor(apiKeyId);
    if (!tenant) return error(403, "Unauthorized tenant mapping");

    const fields = parseFields(event.queryStringParameters?.fields);
    if (!fields) return error(400, "Invalid fields parameter");

    const cacheKey = `${tenant.encompassUserId}|${loanId}|${fields.join(",")}`;
    const cached = readCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      log("INFO", "READ_CACHE_HIT", { loanId, fields: fields.length });
      return json(200, { ...cached.body, _cached: true }, { "Cache-Control": "private, max-age=30" });
    }

    let token;
    try {
      token = await getScopedToken(tenant.encompassUserId);
    } catch (err) {
      log("ERROR", "ENCOMPASS_AUTH_UNAVAILABLE", { loanId, message: err.message });
      return error(502, "Encompass authentication failed");
    }

    const url = `${baseUrl()}/encompass/v1/loans/${encodeURIComponent(loanId)}` +
      `?entities=fields&fields=${encodeURIComponent(fields.join(","))}`;
    const started = now();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (err) {
      log("ERROR", "ENCOMPASS_READ_FAILED", { loanId, message: err.message });
      return error(err.name === "TimeoutError" ? 504 : 502, "Encompass request failed");
    }

    const durationMs = now() - started;
    const status = response.status;
    log("INFO", "ENCOMPASS_READ_COMPLETE", { loanId, status, durationMs, fields: fields.length });

    if (!response.ok) {
      if (status === 423) return error(423, "Loan is locked by Encompass", { code: "FILE_LOCKED" });
      if (status === 404) return error(404, "Loan not found");
      if (status === 429) return error(429, "Encompass rate limit reached");
      if (status === 401 || status === 403) return error(502, "Encompass rejected gateway credentials");
      if (status >= 500) return error(502, "Encompass unavailable");
      return error(400, "Encompass rejected the request", { upstreamStatus: status });
    }

    let loan;
    try {
      loan = await response.json();
    } catch {
      return error(502, "Invalid Encompass response");
    }

    const projected = {};
    for (const field of fields) {
      if (loan && loan[field] !== undefined) projected[field] = loan[field];
    }
    const body = { id: (loan && loan.id) || loanId, fields: projected, _cached: false };
    readCache.set(cacheKey, { body, expiresAt: now() + READ_CACHE_TTL_MS });
    if (readCache.size > READ_CACHE_MAX_ENTRIES) readCache.clear();
    return json(200, body, { "Cache-Control": "private, max-age=30" });
  }

  async function enqueueWrite(event, apiKeyId, loanId) {
    const tenant = await tenantFor(apiKeyId);
    if (!tenant) return error(403, "Unauthorized tenant mapping");

    let payload;
    try {
      payload = JSON.parse(event.body || "");
    } catch {
      return error(400, "Invalid JSON body");
    }
    if (!validFields(payload && payload.fields)) {
      return error(400, "Body must contain a non-empty fields object");
    }

    const allowlist = writeAllowlist(env, tenant.role);
    if (allowlist) {
      const blocked = Object.keys(payload.fields).filter((id) => !allowlist.has(id));
      if (blocked.length) {
        log("WARN", "WRITE_FIELD_NOT_ALLOWED", { loanId, role: tenant.role, blocked: blocked.slice(0, 20) });
        return error(403, "Field not writable for this role", { fields: blocked.slice(0, 20) });
      }
    }

    const createdAt = new Date(now()).toISOString();
    const jobId = `job_${randomUUID()}`;
    const job = {
      jobId,
      loanId,
      apiKeyId,
      encompassUserId: tenant.encompassUserId,
      status: "PENDING",
      attempts: 0,
      error: null,
      createdAt,
      updatedAt: createdAt,
      ttl: Math.floor(now() / 1000) + JOB_TTL_SECONDS,
    };
    await store.putJob(job);

    try {
      await store.enqueueWrite({ jobId, loanId, fields: payload.fields });
    } catch (err) {
      await store.putJob({ ...job, status: "FAILED", error: "Queue unavailable", updatedAt: new Date(now()).toISOString() });
      log("ERROR", "WRITE_ENQUEUE_FAILED", { jobId, loanId, message: err.message });
      return error(503, "Write queue unavailable");
    }

    log("INFO", "WRITE_ENQUEUED", { jobId, loanId, apiKeyId, fieldCount: Object.keys(payload.fields).length });
    return json(202, { status: "ACCEPTED", jobId, loanId, statusUrl: `/v1/jobs/${jobId}` });
  }

  async function jobStatus(apiKeyId, jobId) {
    const tenant = await tenantFor(apiKeyId);
    if (!tenant) return error(403, "Unauthorized tenant mapping");
    const job = await store.getJob(jobId);
    if (!job || job.apiKeyId !== apiKeyId) return error(404, "Job not found");
    return json(200, {
      jobId: job.jobId,
      loanId: job.loanId,
      status: job.status,
      attempts: job.attempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error: job.error || null,
    });
  }

  async function listDocuments(event, apiKeyId, loanId) {
    const query = pickQuery(event.queryStringParameters, DOCUMENT_QUERY_KEYS);
    if (!query) return error(400, "Invalid documents query");

    const scoped = await callForLoan(event, apiKeyId, loanId, "DOCUMENTS_LIST", { path: "/documents", query });
    if (scoped.response) return scoped.response;
    const { result } = scoped;
    if (!result.response.ok) return upstreamFailure(result);

    const documents = Array.isArray(result.body)
      ? result.body
      : Array.isArray(result.body && result.body.documents)
        ? result.body.documents
        : null;
    if (!documents) return error(502, "Invalid Encompass response");

    log("INFO", "DOCUMENTS_READ", { loanId, count: documents.length });
    return json(200, { loanId, documents });
  }

  async function initiateAttachmentUpload(event, apiKeyId, loanId) {
    const query = pickQuery(event.queryStringParameters, ["lockId"]);
    if (!query) return error(400, "Invalid upload query");

    const body = String(event.body || "");
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return error(413, "Request body too large");

    let payload;
    try {
      payload = JSON.parse(body || "null");
    } catch {
      return error(400, "Invalid JSON body");
    }
    const upload = validUpload(payload);
    if (!upload) {
      return error(400, "file.name, file.contentType and file.size are required; assignTo.entityType must be Document");
    }

    const scoped = await callForLoan(event, apiKeyId, loanId, "ATTACHMENT_UPLOAD_INITIATE", {
      path: "/attachmentUploadUrl",
      method: "POST",
      query,
      body: upload,
    });
    if (scoped.response) return scoped.response;
    const { result } = scoped;
    if (!result.response.ok) return upstreamFailure(result);
    if (!result.body || typeof result.body !== "object" || Array.isArray(result.body)) {
      return error(502, "Invalid Encompass response");
    }

    log("INFO", "ATTACHMENT_UPLOAD_INITIATED", {
      loanId,
      attachmentId: result.body.attachmentId || null,
      assigned: Boolean(upload.assignTo),
    });
    return json(200, result.body);
  }

  async function listConditions(event, apiKeyId, loanId) {
    const query = pickQuery(event.queryStringParameters, CONDITION_QUERY_KEYS);
    if (!query) return error(400, "Invalid conditions query");

    const scoped = await callForLoan(event, apiKeyId, loanId, "CONDITIONS_LIST", { path: "/conditions", query });
    if (scoped.response) return scoped.response;
    const { result } = scoped;
    if (!result.response.ok) return upstreamFailure(result);

    const conditions = Array.isArray(result.body)
      ? result.body
      : Array.isArray(result.body && result.body.conditions)
        ? result.body.conditions
        : null;
    if (!conditions) return error(502, "Invalid Encompass response");

    log("INFO", "CONDITIONS_READ", { loanId, count: conditions.length });
    return json(200, { loanId, conditions });
  }

  async function updateConditions(event, apiKeyId, loanId) {
    const body = String(event.body || "");
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return error(413, "Request body too large");

    let updates;
    try {
      updates = JSON.parse(body || "null");
    } catch {
      return error(400, "Invalid JSON body");
    }
    if (!Array.isArray(updates) || updates.length === 0 || updates.length > MAX_CONDITION_UPDATES) {
      return error(400, `Body must be an array of 1-${MAX_CONDITION_UPDATES} condition updates`);
    }
    for (const update of updates) {
      if (
        !update ||
        typeof update !== "object" ||
        Array.isArray(update) ||
        typeof update.id !== "string" ||
        !CONDITION_ID.test(update.id) ||
        update.id.length > 100
      ) {
        return error(400, "Each condition update requires a valid id");
      }
    }

    const scoped = await callForLoan(event, apiKeyId, loanId, "CONDITIONS_UPDATE", {
      path: "/conditions",
      method: "PATCH",
      query: { action: "update" },
      body: updates,
    });
    if (scoped.response) return scoped.response;
    if (!scoped.result.response.ok) return upstreamFailure(scoped.result);

    log("INFO", "CONDITIONS_UPDATED", { loanId, count: updates.length });
    return json(200, { loanId, updated: updates.length });
  }

  async function provision(event, requestId) {
    let payload;
    try {
      payload = JSON.parse(event.body || "");
    } catch {
      return error(400, "Invalid JSON body");
    }

    const role = String((payload && payload.role) || "").trim().toLowerCase();
    const code = String((payload && payload.code) || "");
    const config = roleFor(env, role);
    if (!config || !safeEqual(code, config.code)) {
      log("WARN", "PORTAL_INVITE_REJECTED", { requestId, role });
      return error(403, "Invalid or expired invite link");
    }

    const tenantName = String(payload.tenantName || "").trim();
    const email = String(payload.email || "").trim();
    if (!tenantName || tenantName.length > 100) return error(400, "tenantName is required (max 100 chars)");
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return error(400, "A valid email is required");
    }

    const key = await store.createApiKey({ tenantName, encompassUserId: config.persona });
    await store.putTenant({
      apiKeyId: key.id,
      tenantName,
      email,
      role,
      encompassUserId: config.persona,
      status: "ACTIVE",
      createdAt: new Date(now()).toISOString(),
    });
    log("INFO", "TENANT_PROVISIONED", { tenantName, role, apiKeyId: key.id });
    return json(200, {
      message: "Tenant provisioned successfully",
      apiKey: key.value,
      tenantName,
      email,
      role,
      encompassUserId: config.persona,
    });
  }

  async function processWrite(message, attempts) {
    const { jobId, loanId, fields } = message || {};
    if (!jobId || !loanId || !validFields(fields)) throw new Error("Malformed write message");

    const job = await store.getJob(jobId);
    if (!job) {
      log("WARN", "JOB_NOT_FOUND", { jobId, loanId });
      return;
    }
    if (job.status === "COMPLETED") return;

    const token = await getScopedToken(job.encompassUserId);
    let response;
    try {
      response = await fetchImpl(`${baseUrl()}/encompass/v1/loans/${encodeURIComponent(loanId)}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (err) {
      throw new Error(`Encompass write failed: ${err.message}`);
    }

    const retryable = response.status === 423 || response.status === 429 || response.status >= 500;
    const updatedAt = new Date(now()).toISOString();

    if (!response.ok && !retryable) {
      await store.putJob({ ...job, status: "FAILED", attempts, error: `Encompass rejected update (${response.status})`, updatedAt });
      log("ERROR", "WRITE_REJECTED", { jobId, loanId, status: response.status });
      return;
    }

    if (!response.ok) {
      if (attempts >= MAX_ATTEMPTS) {
        await store.putJob({ ...job, status: "FAILED", attempts, error: `Encompass still returned ${response.status}`, updatedAt });
        log("ERROR", "WRITE_ATTEMPTS_EXHAUSTED", { jobId, loanId, status: response.status, attempts });
        return;
      }
      await store.putJob({ ...job, status: "RETRYING", attempts, error: `Encompass responded ${response.status}`, updatedAt });
      throw new Error(`Retryable Encompass status ${response.status}`);
    }

    await store.putJob({ ...job, status: "COMPLETED", attempts, error: null, updatedAt });
    log("INFO", "WRITE_COMPLETED", { jobId, loanId, attempts });
  }

  async function handleQueue(records) {
    const batchItemFailures = [];
    for (const record of records) {
      const attempts = Number(record.attributes && record.attributes.ApproximateReceiveCount) || 1;
      let jobId;
      try {
        const message = JSON.parse(record.body || "{}");
        jobId = message.jobId;
        await processWrite(message, attempts);
      } catch (err) {
        log("WARN", "WRITE_RETRY_SCHEDULED", {
          jobId,
          messageId: record.messageId,
          attempts,
          message: err.message,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }

  async function handleHttp(event) {
    const method = String(event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method) || "GET").toUpperCase();
    const path = event.path || event.rawPath || "/";
    const requestId = event.requestContext && event.requestContext.requestId;
    const apiKeyId = event.requestContext && event.requestContext.identity && event.requestContext.identity.apiKeyId;
    const started = now();

    log("INFO", "REQUEST_RECEIVED", { requestId, method, path, apiKeyId });
    try {
      if (method === "GET" && path === "/health") return json(200, { status: "ok" });

      if (path === "/portal") {
        if (method === "POST") return await provision(event, requestId);
        if (method !== "GET") return error(405, "Method not allowed");
        const role = String(event.queryStringParameters?.role || "").trim().toLowerCase();
        const code = String(event.queryStringParameters?.code || "");
        if (!role && !code) return html(200, renderPortal());
        const config = roleFor(env, role);
        if (!config || !safeEqual(code, config.code)) {
          log("WARN", "PORTAL_INVITE_REJECTED", { requestId, role: role || "unknown" });
          return html(403, renderPortal({ error: "This invite link is invalid or has expired." }));
        }
        return html(200, renderPortal({ role: config }));
      }

      if (path === "/v1/fields") {
        if (method === "GET") return await fieldDefinitions(event, apiKeyId);
        return error(405, "Method not allowed");
      }

      let match;
      if ((match = path.match(/^\/v1\/loans\/([^/]+)\/(documents|conditions|attachmentUploadUrl)$/))) {
        const loanId = decode(match[1]);
        const resource = match[2];
        if (resource === "documents" && method === "GET") return await listDocuments(event, apiKeyId, loanId);
        if (resource === "conditions" && method === "GET") return await listConditions(event, apiKeyId, loanId);
        if (resource === "conditions" && method === "PATCH") return await updateConditions(event, apiKeyId, loanId);
        if (resource === "attachmentUploadUrl" && method === "POST") return await initiateAttachmentUpload(event, apiKeyId, loanId);
        return error(405, "Method not allowed");
      }
      if ((match = path.match(/^\/v1\/loans\/([^/]+)$/))) {
        const loanId = decode(match[1]);
        if (method === "GET") return await readLoan(event, apiKeyId, loanId);
        if (method === "PATCH") return await enqueueWrite(event, apiKeyId, loanId);
        return error(405, "Method not allowed");
      }
      if ((match = path.match(/^\/v1\/jobs\/([^/]+)$/)) && method === "GET") {
        return await jobStatus(apiKeyId, decode(match[1]));
      }

      return error(404, "Not found");
    } catch (err) {
      log("ERROR", "HANDLER_EXCEPTION", { requestId, method, path, message: err.message, stack: err.stack });
      return error(500, "Internal gateway error");
    } finally {
      log("INFO", "REQUEST_COMPLETE", { requestId, method, path, durationMs: now() - started });
    }
  }

  return async function handler(event) {
    const records = event && event.Records;
    if (Array.isArray(records) && records.length > 0 && records[0].eventSource === "aws:sqs") {
      return handleQueue(records);
    }
    return handleHttp(event || {});
  };
}

function renderPortal({ role, error } = {}) {
  const catalogRows = FIELD_CATALOG.map(
    (field) =>
      `<tr><td>${escapeHtml(field.category)}</td><td>${escapeHtml(field.name)}</td><td class="field-id">${field.id}</td><td>${field.type}</td><td><code>${escapeHtml(field.sample)}</code></td></tr>`,
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Encompass Gateway Portal</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #0f172a; color: #e2e8f0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { width: 100%; max-width: 860px; background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 32px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
  h2 { margin: 0 0 8px; font-size: 15px; }
  p.sub { margin: 6px 0 24px; color: #94a3b8; font-size: 13px; }
  label { display: block; margin: 16px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; font-weight: 600; }
  input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #f8fafc; font: inherit; }
  input:focus { outline: 2px solid #6366f1; outline-offset: 1px; }
  button { width: 100%; margin-top: 20px; padding: 12px; border: 0; border-radius: 8px; background: #4f46e5; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #6366f1; }
  button:disabled { opacity: 0.6; cursor: progress; }
  button.secondary { width: auto; margin: 10px 0 0; padding: 8px 12px; background: #334155; font-size: 12px; }
  .hint { margin: 6px 0 0; font-size: 12px; color: #64748b; }
  .hidden { display: none; }
  .error { margin-top: 16px; padding: 10px 12px; border-radius: 8px; background: #450a0a; border: 1px solid #7f1d1d; color: #fecaca; font-size: 13px; }
  .notice { margin: 18px 0; padding: 14px; border-radius: 10px; background: #0f172a; border: 1px solid #334155; color: #cbd5e1; font-size: 13px; }
  .invite { margin: 18px 0 4px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #312e81; color: #c7d2fe; font-size: 12px; font-weight: 600; }
  .ok { margin-top: 20px; padding: 16px; border-radius: 10px; background: #0f172a; border: 1px solid #065f46; }
  .ok h2 { margin: 0 0 8px; font-size: 14px; color: #34d399; }
  .keyrow { display: flex; gap: 8px; margin-bottom: 14px; }
  .keyrow input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #fde68a; font-size: 13px; }
  .keyrow button { width: auto; margin: 0; padding: 0 14px; background: #334155; }
  .keyrow button:hover { background: #475569; }
  pre { margin: 0 0 4px; padding: 12px; background: #020617; border-radius: 8px; overflow-x: auto; font-size: 12px; color: #cbd5e1; }
  a { color: #a5b4fc; font-size: 12px; }
  .docs { margin-top: 28px; border-top: 1px solid #334155; padding-top: 20px; }
  .table-wrap { overflow-x: auto; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1e293b; white-space: nowrap; }
  th { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  td.field-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #fde68a; }
  code { background: #020617; padding: 1px 5px; border-radius: 4px; font-size: 12px; color: #c7d2fe; }
</style>
</head>
<body>
<main>
  <h1>Encompass API Gateway</h1>
  <p class="sub">Self-serve API access for title, broker, and appraisal partners. Your invite link locks your Encompass persona.</p>

  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}

  ${role
    ? `<section class="invite">
        <span class="badge">${escapeHtml(role.label)}</span>
        <p class="hint">Persona locked to <code>${escapeHtml(role.persona)}</code>. Requests made with your key inherit these permissions.</p>
      </section>
      <form id="form">
        <label for="tenantName">Company name</label>
        <input id="tenantName" type="text" maxlength="100" placeholder="e.g. First American Title" required>
        <label for="email">Developer email</label>
        <input id="email" type="email" maxlength="254" placeholder="dev@firstam.com" required>
        <button id="submit" type="submit">Generate API key</button>
      </form>`
    : `<div class="notice"><strong>Invite link required.</strong> Ask your lender for a role-scoped link such as <code>/portal?role=title&amp;code=...</code>. The link fixes your Encompass persona and permissions.</div>`}

  <div id="error" class="error hidden" role="alert"></div>

  <section id="result" class="ok hidden">
    <h2>Key provisioned successfully</h2>
    <p class="hint">Copy this key now. It is not stored in plaintext and will not be shown again.</p>
    <div class="keyrow">
      <input id="apiKey" readonly>
      <button id="copy" type="button">Copy</button>
    </div>
    <label>Endpoints</label>
    <pre id="endpoints"></pre>
    <label for="curl">Verification cURL</label>
    <pre id="curl"></pre>
    <p><a href="#" id="again">Generate another key with this invite</a></p>
  </section>

  <section class="docs">
    <h2>Common field IDs</h2>
    <p class="hint">Use these in <code>?fields=</code>. For custom fields, call <code>GET /v1/fields?ids=CX.YOUR.FIELD</code>. Live lookups also report <code>readOnly</code> and <code>fieldLock</code> when Encompass provides them.</p>
    <button id="copy-fields" type="button" class="secondary">Copy all field IDs</button>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Category</th><th>Field</th><th>ID</th><th>Type</th><th>Sample</th></tr></thead>
        <tbody>${catalogRows}</tbody>
      </table>
    </div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');
  const lines = (items) => items.join(String.fromCharCode(10));

  const form = $('form');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hide('error');
      const params = new URLSearchParams(location.search);
      const tenantName = $('tenantName').value.trim();
      const email = $('email').value.trim();
      if (!tenantName || !email) {
        $('error').textContent = 'Company name and developer email are required.';
        return show('error');
      }
      const button = $('submit');
      button.disabled = true;
      button.textContent = 'Generating...';
      try {
        const res = await fetch(location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantName,
            email,
            role: params.get('role'),
            code: params.get('code'),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to generate key');
        const base = location.origin;
        $('apiKey').value = data.apiKey;
        $('endpoints').textContent = lines([
          'GET    ' + base + '/v1/loans/{loanId}?fields=11,646',
          'GET    ' + base + '/v1/fields?ids=11,646,CX.TITLE.STATUS',
          'PATCH  ' + base + '/v1/loans/{loanId}',
          'GET    ' + base + '/v1/loans/{loanId}/documents',
          'POST   ' + base + '/v1/loans/{loanId}/attachmentUploadUrl',
          'GET    ' + base + '/v1/loans/{loanId}/conditions',
          'PATCH  ' + base + '/v1/loans/{loanId}/conditions',
          'GET    ' + base + '/v1/jobs/{jobId}',
        ]);
        $('curl').textContent = lines([
          'curl -s "' + base + '/v1/loans/SOME_LOAN_GUID?fields=11,646" -H "x-api-key: ' + data.apiKey + '"',
          'curl -s "' + base + '/v1/fields?ids=11,646,CX.TITLE.STATUS" -H "x-api-key: ' + data.apiKey + '"',
        ]);
        hide('form');
        show('result');
      } catch (err) {
        $('error').textContent = err.message;
        show('error');
      } finally {
        button.disabled = false;
        button.textContent = 'Generate API key';
      }
    });
  }

  if ($('copy')) {
    $('copy').addEventListener('click', async () => {
      $('apiKey').select();
      try { await navigator.clipboard.writeText($('apiKey').value); } catch { document.execCommand('copy'); }
      $('copy').textContent = 'Copied';
      setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
    });
  }

  if ($('copy-fields')) {
    $('copy-fields').addEventListener('click', async () => {
      const ids = Array.from(document.querySelectorAll('td.field-id')).map((cell) => cell.textContent).join(',');
      try { await navigator.clipboard.writeText(ids); } catch { document.execCommand('copy'); }
      $('copy-fields').textContent = 'Copied';
      setTimeout(() => { $('copy-fields').textContent = 'Copy all field IDs'; }, 1500);
    });
  }

  if ($('again')) {
    $('again').addEventListener('click', (event) => {
      event.preventDefault();
      location.reload();
    });
  }
</script>
</body>
</html>`;
}
function createAwsStore(env = process.env) {
  const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
  const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
  const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  const {
    APIGatewayClient,
    CreateApiKeyCommand,
    CreateUsagePlanKeyCommand,
    DeleteApiKeyCommand,
  } = require("@aws-sdk/client-api-gateway");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sqs = new SQSClient({});
  const secrets = new SecretsManagerClient({});
  const apiGateway = new APIGatewayClient({});

  return {
    async getSecret() {
      const res = await secrets.send(new GetSecretValueCommand({ SecretId: env.ENCOMPASS_SECRET_ARN }));
      return { clientId: env.ENCOMPASS_CLIENT_ID, clientSecret: res.SecretString };
    },
    async getTenant(apiKeyId) {
      const res = await ddb.send(new GetCommand({ TableName: env.TENANT_TABLE, Key: { apiKeyId } }));
      return res.Item || null;
    },
    async putTenant(item) {
      await ddb.send(new PutCommand({ TableName: env.TENANT_TABLE, Item: item }));
    },
    async getToken(encompassUserId) {
      const res = await ddb.send(new GetCommand({ TableName: env.TOKEN_TABLE, Key: { encompassUserId } }));
      return res.Item || null;
    },
    async putToken(item) {
      await ddb.send(new PutCommand({ TableName: env.TOKEN_TABLE, Item: item }));
    },
    async getJob(jobId) {
      const res = await ddb.send(new GetCommand({ TableName: env.JOB_TABLE, Key: { jobId } }));
      return res.Item || null;
    },
    async putJob(item) {
      await ddb.send(new PutCommand({ TableName: env.JOB_TABLE, Item: item }));
    },
    async enqueueWrite(message) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: env.WRITE_QUEUE_URL,
        MessageBody: JSON.stringify(message),
        MessageGroupId: message.loanId,
        MessageDeduplicationId: message.jobId,
      }));
    },
    async createApiKey({ tenantName, encompassUserId }) {
      const created = await apiGateway.send(new CreateApiKeyCommand({
        name: `tenant-${tenantName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${randomUUID().slice(0, 8)}`,
        description: `Encompass gateway key for ${tenantName} mapped to ${encompassUserId}`,
        enabled: true,
        generateDistinctId: true,
      }));
      try {
        await apiGateway.send(new CreateUsagePlanKeyCommand({
          usagePlanId: env.USAGE_PLAN_ID,
          keyId: created.id,
          keyType: "API_KEY",
        }));
      } catch (err) {
        await apiGateway.send(new DeleteApiKeyCommand({ apiKey: created.id })).catch(() => {});
        throw err;
      }
      return { id: created.id, value: created.value };
    },
  };
}

let defaultHandler = null;

exports.handler = async (event, context) => {
  if (!defaultHandler) defaultHandler = createHandler({ store: createAwsStore(process.env) });
  return defaultHandler(event, context);
};

exports.createHandler = createHandler;
exports.createAwsStore = createAwsStore;
exports.renderPortal = renderPortal;
exports._resetReadCache = () => {
  readCache.clear();
  fieldCache.clear();
};
