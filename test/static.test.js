"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const REPO = "https://github.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-";
const PAGE = "https://spuds0588.github.io/Encompass-API-Passhrough-Middleware-Gateway-/";

test("community documents exist and point contributors at GitHub", () => {
  for (const file of ["agents.md", "CONTRIBUTING.md", "llms.txt", "index.html", "robots.txt", "sitemap.xml"]) {
    assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
    assert.ok(read(file).length > 0, `${file} is empty`);
  }

  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /community-supported/i);
  assert.match(contributing, /issues/);
  assert.match(contributing, /pull request/i);
  assert.match(contributing, /npm run verify/);
  assert.match(contributing, /secret/i);
  assert.match(contributing, /loan data/i);
});

test("llms.txt gives agents the shared-responsibility and upstreaming rules", () => {
  const llms = read("llms.txt").toLowerCase();
  for (const phrase of [
    "community-supported",
    "shared community responsibility",
    "github issues",
    "pull request",
    "agents.md",
    "contributing.md",
    "get /v1/fields",
    "not verified by the maintainers",
    "do not claim live encompass or aws verification",
    "never include client secrets",
  ]) {
    assert.ok(llms.includes(phrase), `llms.txt is missing: ${phrase}`);
  }
});

test("index.html has SEO/AEO metadata, valid JSON-LD, and contribution links", () => {
  const page = read("index.html");
  assert.match(page, /<title>[^<]*Encompass API Passthrough Gateway/i);
  assert.match(page, /name="description"/);
  assert.match(page, /rel="canonical"/);
  assert.ok(page.includes(PAGE), "canonical or page URL is missing");
  assert.ok(page.includes(`${REPO}/issues/new`), "new-issue link is missing");
  assert.ok(page.includes(`${REPO}/pulls`), "pull-request link is missing");
  assert.match(page, /llms\.txt/);
  assert.match(page, /community-supported/i);
  assert.match(page, /not affiliated/i);

  const jsonLd = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(jsonLd, "JSON-LD script is missing");
  const graph = JSON.parse(jsonLd[1])["@graph"];
  assert.ok(graph.some((node) => node["@type"] === "SoftwareSourceCode"), "SoftwareSourceCode schema is missing");
  assert.ok(graph.some((node) => node["@type"] === "FAQPage"), "FAQPage schema is missing");
  assert.ok(Array.isArray(graph.find((node) => node["@type"] === "FAQPage").mainEntity));
});

test("all community surfaces state the shared-support contract", () => {
  const surfaces = ["agents.md", "llms.txt", "index.html", "README.md", "CONTRIBUTING.md"];
  const required = [
    "community-supported",
    "shared responsibility",
    "maintainer",
    "live encompass",
    "lender aws account",
    "github issues",
    "issues or pull requests",
    "pull request",
    "sanitized",
    "redacted field shapes",
    "deployment or log excerpts",
    "field-shape",
    "never secrets or pii",
    "privately-patched forks are discouraged",
    "do not claim live",
  ];

  for (const file of surfaces) {
    const text = read(file).toLowerCase().replace(/\s+/g, " ");
    for (const phrase of required) {
      assert.ok(text.includes(phrase), `${file} is missing community contract phrase: ${phrase}`);
    }
  }
});

test("agents.md states enforceable YAGNI, short-solution, and cleanup rules", () => {
  const agents = read("agents.md").toLowerCase().replace(/\s+/g, " ");
  for (const phrase of [
    "yagni",
    "speculative endpoints",
    "shortest working solution",
    "one-line",
    "node_modules",
    "build output",
    "logs",
    "temp files",
    "no running processes",
  ]) {
    assert.ok(agents.includes(phrase), `agents.md is missing enforceable rule: ${phrase}`);
  }
});

test("robots.txt and sitemap.xml use the GitHub Pages canonical URL", () => {
  assert.match(read("robots.txt"), new RegExp(`Sitemap: ${PAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}sitemap\\.xml`));
  const sitemap = read("sitemap.xml");
  assert.ok(sitemap.includes(`<loc>${PAGE}</loc>`), "sitemap is missing the canonical page");
  assert.match(sitemap, /<lastmod>2026-11-06<\/lastmod>/);
});
