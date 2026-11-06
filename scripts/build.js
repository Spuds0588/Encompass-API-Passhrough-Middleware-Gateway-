#!/usr/bin/env node
"use strict";

/**
 * Builds the deployable single-file CloudFormation template by inlining
 * src/gateway.js into infra/template.yaml.
 *
 * Usage: node scripts/build.js [--check]
 *   --check  fail if the committed template.yaml is out of date
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "infra", "template.yaml");
const codePath = path.join(root, "src", "gateway.js");
const outputPath = path.join(root, "template.yaml");
const PLACEHOLDER = /^[ \t]*\/\/__GATEWAY_CODE__$/m;
const INDENT = " ".repeat(10);
const LIMIT_BYTES = 51200;

const code = fs.readFileSync(codePath, "utf8").trimEnd();
if (/require\(["']\.\.?\//.test(code)) {
  throw new Error("src/gateway.js must be self-contained: no relative require() calls");
}

const source = fs.readFileSync(sourcePath, "utf8");
if (!PLACEHOLDER.test(source)) {
  throw new Error(`${sourcePath} is missing the //__GATEWAY_CODE__ placeholder`);
}

const inlined = code
  .split("\n")
  .map((line) => (line.length > 0 ? INDENT + line : ""))
  .join("\n");

const rendered = source.replace(PLACEHOLDER, () => inlined);
const bytes = Buffer.byteLength(rendered);

if (bytes > LIMIT_BYTES) {
  throw new Error(
    `template.yaml would be ${bytes} bytes, over CloudFormation's ${LIMIT_BYTES}-byte direct-upload limit`,
  );
}

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== rendered) {
    console.error("template.yaml is stale. Run: npm run build");
    process.exit(1);
  }
  console.log(`template.yaml is up to date (${bytes} bytes)`);
} else {
  fs.writeFileSync(outputPath, rendered);
  console.log(`Wrote template.yaml (${bytes} bytes, ${Buffer.byteLength(code)} bytes of handler code)`);
}
