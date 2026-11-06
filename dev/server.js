"use strict";

/**
 * Local API Gateway + SQS emulator for the gateway Lambda.
 * Runs the real handler against a fake Encompass and in-memory storage so the
 * full HTTP flow can be exercised without AWS.
 */

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { createHandler } = require("../src/gateway");
const { createMemoryStore } = require("./memory-store");
const { startFakeEncompass } = require("./fake-encompass");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "local-admin-token-change-me-1234";

async function createDevGateway({ port = 0, fakeEncompass = null } = {}) {
  const encompass = fakeEncompass || (await startFakeEncompass());
  const store = createMemoryStore();
  const handler = createHandler({
    store,
    env: {
      ENCOMPASS_BASE_URL: encompass.url,
      ADMIN_TOKEN,
      UPSTREAM_TIMEOUT_MS: "4000",
    },
  });

  const drain = async (maxRounds = 6) => {
    const summary = { rounds: 0, processed: 0, retried: 0 };
    for (let round = 0; round < maxRounds && store.queue.length > 0; round += 1) {
      summary.rounds += 1;
      const batch = store.queue.splice(0, 10);
      const records = batch.map((message) => {
        message.receives += 1;
        return {
          messageId: randomUUID(),
          eventSource: "aws:sqs",
          body: JSON.stringify({ jobId: message.jobId, loanId: message.loanId, fields: message.fields }),
          attributes: { ApproximateReceiveCount: String(message.receives) },
        };
      });
      const result = await handler({ Records: records });
      const failed = new Set(result.batchItemFailures.map((item) => item.itemIdentifier));
      records.forEach((record, index) => {
        if (failed.has(record.messageId)) {
          store.queue.push(batch[index]);
          summary.retried += 1;
        } else {
          summary.processed += 1;
        }
      });
    }
    return summary;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");

    if (req.method === "POST" && url.pathname === "/dev/drain") {
      const summary = await drain();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(summary));
    }

    const apiKey = req.headers["x-api-key"];
    const apiKeyId = apiKey ? store.keyIdsByValue.get(apiKey) : undefined;
    if (url.pathname.startsWith("/v1/") && !apiKeyId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Forbidden" }));
    }

    const event = {
      httpMethod: req.method,
      path: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: body || null,
      requestContext: { requestId: randomUUID(), identity: apiKeyId ? { apiKeyId } : {} },
    };

    const result = await handler(event);
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body || "");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    store,
    encompass,
    adminToken: ADMIN_TOKEN,
    drain,
    close: async () => {
      await new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      });
      await encompass.close();
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createDevGateway({ port }).then((gateway) => {
    console.log(`Gateway:     ${gateway.url}`);
    console.log(`Portal:      ${gateway.url}/portal`);
    console.log(`Admin token: ${gateway.adminToken}`);
    console.log(`Encompass:   ${gateway.encompass.url} (fake)`);
    console.log("Press Ctrl+C to stop.");
  });
}

module.exports = { createDevGateway };
