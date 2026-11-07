"use strict";

/**
 * Fake Encompass API for local development and tests.
 * Speaks just enough of the OAuth, loan, schema, eFolder document, attachment
 * upload, and enhanced-condition endpoints that the gateway exercises.
 */

const http = require("node:http");

const FIELD_DEFINITIONS = {
  11: { description: "Subject Property Address", format: "STRING" },
  12: { description: "Subject Property City", format: "STRING" },
  14: { description: "Subject Property State", format: "STRING" },
  15: { description: "Subject Property Zip", format: "STRING" },
  3: { description: "Interest Rate", format: "DECIMAL" },
  763: { description: "Estimated Closing Date", format: "DATE" },
  1109: { description: "Loan Amount", format: "DECIMAL" },
  1393: { description: "Active Milestone", format: "STRING", readOnly: true, fieldLock: true },
  646: { description: "Title - Lender Title Insurance", format: "DECIMAL" },
  647: { description: "Title - Owner's Title Insurance", format: "DECIMAL" },
  648: { description: "Settlement / Escrow Fee", format: "DECIMAL" },
  "CX.TITLE.STATUS": { description: "Custom Title Milestone Status", format: "STRING" },
  "CX.TITLE.FEE": { description: "Custom Title Fee", format: "DECIMAL" },
};

const DEFAULT_LOAN = {
  id: "loan-1",
  11: "123 Main St",
  12: "Irvine",
  14: "CA",
  1109: 450000,
  "CX.TITLE.STATUS": "Received",
  "CX.TITLE.FEE": 1250,
};

const DEFAULT_DOCUMENTS = {
  "loan-1": [
    {
      id: "doc-1",
      title: "Credit Report",
      isRemoved: false,
      attachments: [
        {
          id: "attachment-1",
          fileName: "credit-report.pdf",
          contentType: "application/pdf",
          fileSize: 2048,
          isActive: true,
          dateAdded: "2026-11-01T12:00:00Z",
        },
      ],
    },
    { id: "doc-2", title: "Title Commitment", isRemoved: false, attachments: [] },
  ],
};

const DEFAULT_CONDITIONS = {
  "loan-1": [
    {
      id: "condition-1",
      conditionType: "Underwriting",
      title: "Provide signed federal tax returns",
      internalDescription: "All pages and schedules for the last two years.",
      status: "Requested",
      statusDate: "2026-11-01T12:00:00Z",
      statusOpen: true,
      isRemoved: false,
      tracking: [
        { status: "Requested", isChecked: true, date: "2026-11-01T12:00:00Z" },
        { status: "Received", isChecked: false },
        { status: "Cleared", isChecked: false },
      ],
    },
    {
      id: "condition-2",
      conditionType: "Title",
      title: "Provide title commitment",
      internalDescription: "",
      status: "Cleared",
      statusDate: "2026-10-30T09:00:00Z",
      statusOpen: false,
      isRemoved: false,
      tracking: [{ status: "Cleared", isChecked: true, date: "2026-10-30T09:00:00Z" }],
    },
  ],
};

const isCustomField = (id) => id.startsWith("CX.") || /^CUST\d{2}FV$/.test(id);
const timestamp = () => new Date().toISOString();

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

function startFakeEncompass({
  port = 0,
  loans = {},
  lockAttempts = {},
  tokenTtlSeconds = 1800,
  documents = DEFAULT_DOCUMENTS,
  conditions = DEFAULT_CONDITIONS,
  nestedFields = false,
} = {}) {
  const state = {
    nestedFields,
    tokenExchanges: 0,
    reads: 0,
    writes: 0,
    standardSchemaCalls: 0,
    customSchemaCalls: 0,
    schemaFailure: 0,
    documentReads: 0,
    conditionReads: 0,
    conditionUpdates: 0,
    uploadInitiations: 0,
    uploadPuts: 0,
    uploadedBytes: 0,
    downloadInitiations: 0,
    downloadGets: 0,
    downloadedBytes: 0,
    tokens: new Set(),
    loans: new Map(Object.entries(loans).map(([id, loan]) => [id, { ...loan, id }])),
    lockRemaining: new Map(Object.entries(lockAttempts)),
    documents: new Map(),
    conditions: new Map(),
    uploads: new Map(),
    contents: new Map(),
  };
  if (state.loans.size === 0) state.loans.set(DEFAULT_LOAN.id, { ...DEFAULT_LOAN });

  for (const [loanId, docs] of Object.entries(documents)) {
    if (state.loans.has(loanId)) state.documents.set(loanId, JSON.parse(JSON.stringify(docs)));
  }
  for (const [loanId, items] of Object.entries(conditions)) {
    if (state.loans.has(loanId)) state.conditions.set(loanId, JSON.parse(JSON.stringify(items)));
  }
  for (const [loanId, docs] of state.documents) {
    for (const doc of docs) {
      for (const attachment of doc.attachments || []) {
        state.contents.set(attachment.id, {
          loanId,
          content: Buffer.from(`${attachment.fileName}-content`),
          contentType: attachment.contentType,
        });
      }
    }
  }

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const authorized = (req) => state.tokens.has(String(req.headers.authorization || "").replace(/^Bearer /, ""));

  const findAttachment = (loanId, attachmentId) =>
    (state.documents.get(loanId) || [])
      .flatMap((doc) => doc.attachments || [])
      .find((attachment) => attachment.id === attachmentId) || null;

  const schemaEntries = (url, custom) => {
    const ids = String(url.searchParams.get("ids") || "").split(",").filter(Boolean);
    return ids
      .filter((id) => isCustomField(id) === custom && FIELD_DEFINITIONS[id])
      .map((id) => ({ id, ...FIELD_DEFINITIONS[id] }));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const raw = await readBody(req);

    if (req.method === "POST" && url.pathname === "/oauth2/v1/token") {
      const params = new URLSearchParams(raw.toString("utf8"));
      if (params.get("client_id") !== "test-client" || params.get("client_secret") !== "test-secret") {
        return send(res, 401, { error: "invalid_client" });
      }
      if (!params.get("subject_user_id")) return send(res, 400, { error: "invalid_request" });
      state.tokenExchanges += 1;
      const token = `tok-${params.get("subject_user_id")}-${state.tokenExchanges}`;
      state.tokens.add(token);
      return send(res, 200, { access_token: token, token_type: "Bearer", expires_in: tokenTtlSeconds });
    }

    // Pre-signed PUT target. It authenticates with the upload authorization
    // header, not with the bearer token, exactly like Encompass cloud storage.
    const uploadMatch = url.pathname.match(/^\/upload\/([^/]+)$/);
    if (uploadMatch && req.method === "PUT") {
      const attachmentId = decodeURIComponent(uploadMatch[1]);
      const pending = state.uploads.get(attachmentId);
      if (!pending || req.headers.authorization !== pending.authorizationHeader) {
        return send(res, 401, { error: "invalid_upload_authorization" });
      }
      const bytes = raw.length;
      state.uploadPuts += 1;
      state.uploadedBytes += bytes;
      const docs = state.documents.get(pending.loanId) || [];
      let document = pending.assignTo ? docs.find((item) => item.id === pending.assignTo.entityId) : null;
      if (!document) {
        document = { id: `doc-unassigned-${attachmentId}`, title: "Unassigned", isRemoved: false, attachments: [] };
        docs.push(document);
        state.documents.set(pending.loanId, docs);
      }
      document.attachments.push({
        id: attachmentId,
        fileName: pending.file.name,
        contentType: pending.file.contentType,
        fileSize: bytes,
        isActive: true,
        dateAdded: timestamp(),
      });
      pending.uploaded = true;
      state.contents.set(attachmentId, {
        loanId: pending.loanId,
        content: Buffer.from(raw),
        contentType: pending.file.contentType,
      });
      return send(res, 200, {});
    }

    // Pre-signed GET target, authenticated by the download authorization header.
    const downloadMatch = url.pathname.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && req.method === "GET") {
      const attachmentId = decodeURIComponent(downloadMatch[1]);
      const entry = state.contents.get(attachmentId);
      if (!entry) return send(res, 404, { error: "attachment_not_found" });
      if (req.headers.authorization !== `download-auth-${attachmentId}`) {
        return send(res, 401, { error: "invalid_download_authorization" });
      }
      state.downloadGets += 1;
      state.downloadedBytes += entry.content.length;
      res.writeHead(200, {
        "Content-Type": entry.contentType || "application/octet-stream",
        "Content-Length": entry.content.length,
      });
      return res.end(entry.content);
    }

    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/encompass/v3/schemas/loan/standardFields") {
      state.standardSchemaCalls += 1;
      if (state.schemaFailure) return send(res, state.schemaFailure, { error: "schema_unavailable" });
      return send(res, 200, schemaEntries(url, false));
    }

    if (req.method === "GET" && url.pathname === "/encompass/v3/settings/loan/customFields") {
      state.customSchemaCalls += 1;
      if (state.schemaFailure) return send(res, state.schemaFailure, { error: "schema_unavailable" });
      return send(res, 200, schemaEntries(url, true));
    }

    const documentsMatch = url.pathname.match(/^\/encompass\/v3\/loans\/([^/]+)\/documents$/);
    if (documentsMatch && req.method === "GET") {
      const loanId = decodeURIComponent(documentsMatch[1]);
      if (!state.loans.has(loanId)) return send(res, 404, { error: "loan_not_found" });
      state.documentReads += 1;
      let items = state.documents.get(loanId) || [];
      if (url.searchParams.get("includeRemoved") !== "true") items = items.filter((item) => !item.isRemoved);
      if (url.searchParams.get("requireActiveAttachments") === "true") {
        items = items.filter((item) => (item.attachments || []).some((attachment) => attachment.isActive !== false));
      }
      const start = Math.max(0, Number(url.searchParams.get("start")) || 0);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const view = url.searchParams.get("view") || "detail";
      const page = items.slice(start, start + limit).map((item) =>
        view === "summary" ? { id: item.id, title: item.title } : item,
      );
      return send(res, 200, page);
    }

    const conditionsMatch = url.pathname.match(/^\/encompass\/v3\/loans\/([^/]+)\/conditions$/);
    if (conditionsMatch) {
      const loanId = decodeURIComponent(conditionsMatch[1]);
      if (!state.loans.has(loanId)) return send(res, 404, { error: "loan_not_found" });
      const items = state.conditions.get(loanId) || [];

      if (req.method === "GET") {
        state.conditionReads += 1;
        let visible = url.searchParams.get("includeRemoved") === "true" ? items : items.filter((item) => !item.isRemoved);
        const type = url.searchParams.get("conditionType");
        if (type) visible = visible.filter((item) => item.conditionType === type);
        return send(res, 200, visible);
      }

      if (req.method === "PATCH" && url.searchParams.get("action") === "update") {
        let updates;
        try {
          updates = JSON.parse(raw.toString("utf8"));
        } catch {
          return send(res, 400, { error: "invalid_json" });
        }
        if (!Array.isArray(updates)) return send(res, 400, { error: "invalid_condition_update" });

        const updated = [];
        for (const update of updates) {
          const condition = items.find((item) => item.id === (update && update.id));
          if (!condition) return send(res, 404, { error: "condition_not_found" });
          if (Array.isArray(update.tracking)) {
            for (const change of update.tracking) {
              if (!change || typeof change.status !== "string") continue;
              let entry = condition.tracking.find((item) => item.status === change.status);
              if (!entry) {
                entry = { status: change.status, isChecked: false };
                condition.tracking.push(entry);
              }
              if (change.isChecked !== undefined) entry.isChecked = change.isChecked === true;
              entry.date = timestamp();
            }
            const checked = condition.tracking.filter((entry) => entry.isChecked);
            if (checked.length) {
              condition.status = checked[checked.length - 1].status;
              condition.statusDate = timestamp();
              condition.statusOpen = !["Cleared", "Fulfilled"].includes(condition.status);
            }
          }
          if (typeof update.internalDescription === "string") condition.internalDescription = update.internalDescription;
          updated.push(condition);
        }
        state.conditionUpdates += 1;
        return send(res, 200, updated);
      }

      return send(res, 405, { error: "method_not_allowed" });
    }

    const downloadUrlMatch = url.pathname.match(/^\/encompass\/v3\/loans\/([^/]+)\/attachmentDownloadUrl$/);
    if (downloadUrlMatch && req.method === "POST") {
      const loanId = decodeURIComponent(downloadUrlMatch[1]);
      if (!state.loans.has(loanId)) return send(res, 404, { error: "loan_not_found" });
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      const ids = payload && Array.isArray(payload.attachments) ? payload.attachments : null;
      if (!ids || ids.length === 0) return send(res, 400, { error: "attachments_required" });
      const downloads = [];
      for (const id of ids) {
        const attachment = findAttachment(loanId, id);
        if (!attachment || !state.contents.has(id)) return send(res, 404, { error: "attachment_not_found" });
        downloads.push({
          id,
          url: `http://${req.headers.host}/download/${encodeURIComponent(id)}`,
          authorizationHeader: `download-auth-${id}`,
          contentType: attachment.contentType,
          type: "Cloud",
        });
      }
      state.downloadInitiations += 1;
      return send(res, 200, downloads);
    }

    const uploadMatchV3 = url.pathname.match(/^\/encompass\/v3\/loans\/([^/]+)\/attachmentUploadUrl$/);
    if (uploadMatchV3 && req.method === "POST") {
      const loanId = decodeURIComponent(uploadMatchV3[1]);
      if (!state.loans.has(loanId)) return send(res, 404, { error: "loan_not_found" });
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      const file = payload && payload.file;
      if (!file || !file.name || !file.contentType || file.size === undefined) {
        return send(res, 400, { error: "file_required" });
      }
      if (payload.assignTo) {
        if (payload.assignTo.entityType !== "Document") return send(res, 400, { error: "invalid_assign_to" });
        const docs = state.documents.get(loanId) || [];
        if (!docs.some((item) => item.id === payload.assignTo.entityId)) {
          return send(res, 404, { error: "document_not_found" });
        }
      }
      state.uploadInitiations += 1;
      const attachmentId = `attachment-${state.uploadInitiations + 10}`;
      const authorizationHeader = `upload-auth-${state.uploadInitiations}`;
      state.uploads.set(attachmentId, {
        loanId,
        file,
        assignTo: payload.assignTo || null,
        title: payload.title || file.name,
        authorizationHeader,
        uploaded: false,
      });
      return send(res, 200, {
        attachmentId,
        authorizationHeader,
        url: `http://${req.headers.host}/upload/${encodeURIComponent(attachmentId)}`,
        multiChunkRequired: false,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    }

    const match = url.pathname.match(/^\/encompass\/v1\/loans\/([^/]+)$/);
    if (!match) return send(res, 404, { error: "not_found" });

    const loanId = decodeURIComponent(match[1]);
    const loan = state.loans.get(loanId);

    if (req.method === "GET") {
      state.reads += 1;
      if (!loan) return send(res, 404, { error: "loan_not_found" });
      if (!state.nestedFields) return send(res, 200, loan);
      const { id, ...fields } = loan;
      return send(res, 200, { id, fields });
    }

    if (req.method === "PATCH") {
      state.writes += 1;
      const locks = state.lockRemaining.get(loanId) || 0;
      if (locks > 0) {
        state.lockRemaining.set(loanId, locks - 1);
        return send(res, 423, { error: "locked" });
      }
      if (!loan) return send(res, 404, { error: "loan_not_found" });
      let patch;
      try {
        patch = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      Object.assign(loan, patch);
      return send(res, 204);
    }

    return send(res, 405, { error: "method_not_allowed" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

module.exports = { startFakeEncompass, DEFAULT_LOAN, DEFAULT_DOCUMENTS, DEFAULT_CONDITIONS, FIELD_DEFINITIONS };
