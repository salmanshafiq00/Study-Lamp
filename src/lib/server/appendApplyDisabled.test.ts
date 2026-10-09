import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { appendApplyDisabledHandler } from "./appendApplyDisabled";
import { createAuthedRoute } from "./routeHelpers";

const ROUTES = {
  docs: "src/app/api/drive/docs/append/apply/route.ts",
  sheets: "src/app/api/drive/sheets/append/apply/route.ts",
} as const;

function request(): NextRequest {
  return new NextRequest("http://localhost/api/drive/append/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planToken: "x", accepted: ["a"], documentId: "1AbC_dEfGhIjKlMnOpQrStUvWxYz0123456789" }),
  });
}

describe("append apply hotfix (D14)", () => {
  const route = createAuthedRoute(async (req) => (req.headers.get("authorization") ? "uid-1" : null), appendApplyDisabledHandler);

  it("returns 401 when the caller is not authenticated", async () => {
    const response = await route(request(), { params: {} });
    assert.equal(response.status, 401);
  });

  it("returns 503 {error:'Temporarily unavailable'} for an authenticated caller", async () => {
    const req = new NextRequest("http://localhost/x", { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    const response = await route(req, { params: {} });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Temporarily unavailable" });
  });

  for (const [kind, path] of Object.entries(ROUTES)) {
    it(`${kind} apply route uses the disabled handler and never reaches Drive/Google code`, () => {
      const source = readFileSync(path, "utf8");
      assert.ok(source.includes("appendApplyDisabledHandler"));
      for (const forbidden of ["withDriveAccessToken", "googleAppendApply", "googleAppendDeps", "firebase-admin", "readJsonObject"]) {
        assert.equal(source.includes(forbidden), false, `${path} must not reference ${forbidden}`);
      }
    });
  }

  it("the handler module itself imports nothing that can write", () => {
    const source = readFileSync("src/lib/server/appendApplyDisabled.ts", "utf8");
    const imports = [...source.matchAll(/^import .* from "(.+)";/gm)].map((match) => match[1]);
    assert.deepEqual(imports, ["next/server"]);
  });
});
