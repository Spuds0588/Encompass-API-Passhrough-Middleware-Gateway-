"use strict";

/**
 * Fake Encompass API for local development and tests.
 * Speaks just enough of the OAuth, loan, and field-schema endpoints that the
 * gateway exercises.
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
  1393: { description: "Active Milestone", format: "STRING" },
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

const isCustomField = (id) => id.startsWith("CX.") || /^CUST\d{2}FV$/.test(id);

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });

function startFakeEncompass({ port = 0, loans = {}, lockAttempts = {}, tokenTtlSeconds = 1800 } = {}) {
  const state = {
    tokenExchanges: 0,
    reads: 0,
    writes: 0,
    standardSchemaCalls: 0,
    customSchemaCalls: 0,
    schemaFailure: 0,
    tokens: new Set(),
    loans: new Map(Object.entries(loans).map(([id, loan]) => [id, { ...loan, id }])),
    lockRemaining: new Map(Object.entries(lockAttempts)),
  };
  if (state.loans.size === 0) state.loans.set(DEFAULT_LOAN.id, { ...DEFAULT_LOAN });

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const authorized = (req) => state.tokens.has(String(req.headers.authorization || "").replace(/^Bearer /, ""));

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
      const params = new URLSearchParams(raw);
      if (params.get("client_id") !== "test-client" || params.get("client_secret") !== "test-secret") {
        return send(res, 401, { error: "invalid_client" });
      }
      if (!params.get("subject_user_id")) return send(res, 400, { error: "invalid_request" });
      state.tokenExchanges += 1;
      const token = `tok-${params.get("subject_user_id")}-${state.tokenExchanges}`;
      state.tokens.add(token);
      return send(res, 200, { access_token: token, token_type: "Bearer", expires_in: tokenTtlSeconds });
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

    const match = url.pathname.match(/^\/encompass\/v1\/loans\/([^/]+)$/);
    if (!match) return send(res, 404, { error: "not_found" });

    const loanId = decodeURIComponent(match[1]);
    const loan = state.loans.get(loanId);

    if (req.method === "GET") {
      state.reads += 1;
      return loan ? send(res, 200, loan) : send(res, 404, { error: "loan_not_found" });
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
        patch = JSON.parse(raw);
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

module.exports = { startFakeEncompass, DEFAULT_LOAN, FIELD_DEFINITIONS };
