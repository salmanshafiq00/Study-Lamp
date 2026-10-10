import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";

// Keeps docs/deploy.md and docs/google-workspace.md in sync with the OAuth
// callback routes that exist in the code. Runs from the project root
// (scripts/runTests.mjs), so paths are relative to process.cwd().

const ROOT = process.cwd();
const API_DIR = join(ROOT, "src", "app", "api");
const SERVER_DIR = join(ROOT, "src", "lib", "server");
const CALLBACK_PATH = /\/api\/[a-z0-9/_-]+\/auth\/callback/g;

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

/** Redirect paths implied by route files: src/app/api/<x>/auth/callback/route.ts -> /api/<x>/auth/callback */
function pathsFromRoutes(): string[] {
  return walk(API_DIR)
    .filter((file) => /[\\/]auth[\\/]callback[\\/]route\.ts$/.test(file))
    .map((file) => "/" + relative(join(ROOT, "src", "app"), file).split(sep).slice(0, -1).join("/"));
}

/** Redirect paths named in server code (the values sent to Google as redirect_uri). */
function pathsFromServerCode(): string[] {
  const found = new Set<string>();
  for (const file of walk(SERVER_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(new RegExp(`["'\`](${CALLBACK_PATH.source})["'\`]`, "g"))) {
      found.add(match[1]);
    }
  }
  return [...found];
}

function documentedPaths(doc: string): string[] {
  return [...new Set(readFileSync(join(ROOT, "docs", doc), "utf8").match(CALLBACK_PATH) ?? [])];
}

describe("OAuth redirect paths are documented", () => {
  const routePaths = [...new Set(pathsFromRoutes())].sort();
  const codePaths = [...new Set(pathsFromServerCode())].sort();

  it("finds the callback route and the redirect constant", () => {
    assert.ok(routePaths.length >= 1, `expected at least one callback route, found: ${routePaths.join(", ")}`);
    assert.ok(codePaths.length >= 1, `expected at least one redirect constant, found: ${codePaths.join(", ")}`);
  });

  it("every redirect path sent to Google has a callback route", () => {
    for (const path of codePaths) assert.ok(routePaths.includes(path), `${path} is used in server code but has no route file`);
  });

  for (const doc of ["deploy.md", "google-workspace.md"]) {
    it(`docs/${doc} lists every redirect path used by the code`, () => {
      const documented = documentedPaths(doc);
      for (const path of new Set([...routePaths, ...codePaths])) {
        assert.ok(documented.includes(path), `docs/${doc} does not mention ${path}; add it to the redirect URI list.`);
      }
    });
  }

  it("docs/deploy.md does not list a redirect path that no longer exists", () => {
    const known = new Set([...routePaths, ...codePaths]);
    for (const path of documentedPaths("deploy.md")) {
      assert.ok(known.has(path), `docs/deploy.md lists ${path} but no code uses it; remove it from the Google client and the docs.`);
    }
  });
});
