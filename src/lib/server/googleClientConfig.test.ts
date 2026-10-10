import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getGoogleClient, pickerAppIdFromClientId } from "./googleClientConfig";

describe("getGoogleClient", () => {
  it("prefers the shared GOOGLE_CLIENT_* names", () => {
    const env = { GOOGLE_CLIENT_ID: "shared-id", GOOGLE_CLIENT_SECRET: "shared-secret", GOOGLE_DRIVE_CLIENT_ID: "d", GOOGLE_DRIVE_CLIENT_SECRET: "ds" };
    assert.deepEqual(getGoogleClient("drive", env), { clientId: "shared-id", clientSecret: "shared-secret" });
    assert.deepEqual(getGoogleClient("workspace", env), { clientId: "shared-id", clientSecret: "shared-secret" });
  });

  it("falls back to the legacy flow-specific names", () => {
    const env = { GOOGLE_DRIVE_CLIENT_ID: "d", GOOGLE_DRIVE_CLIENT_SECRET: "ds", GOOGLE_WORKSPACE_CLIENT_ID: "w", GOOGLE_WORKSPACE_CLIENT_SECRET: "ws" };
    assert.deepEqual(getGoogleClient("drive", env), { clientId: "d", clientSecret: "ds" });
    assert.deepEqual(getGoogleClient("workspace", env), { clientId: "w", clientSecret: "ws" });
  });

  it("returns null for partial or empty pairs and ignores the other flow's legacy names", () => {
    assert.equal(getGoogleClient("drive", { GOOGLE_CLIENT_ID: "only-id" }), null);
    assert.equal(getGoogleClient("drive", { GOOGLE_DRIVE_CLIENT_ID: "d" }), null);
    assert.equal(getGoogleClient("drive", { GOOGLE_WORKSPACE_CLIENT_ID: "w", GOOGLE_WORKSPACE_CLIENT_SECRET: "ws" }), null);
    assert.equal(getGoogleClient("workspace", {}), null);
  });

  it("falls through when the shared pair is partial", () => {
    const env = { GOOGLE_CLIENT_ID: "shared-id", GOOGLE_DRIVE_CLIENT_ID: "d", GOOGLE_DRIVE_CLIENT_SECRET: "ds" };
    assert.deepEqual(getGoogleClient("drive", env), { clientId: "d", clientSecret: "ds" });
  });

  it("trims whitespace", () => {
    assert.deepEqual(getGoogleClient("drive", { GOOGLE_CLIENT_ID: " a ", GOOGLE_CLIENT_SECRET: " b " }), { clientId: "a", clientSecret: "b" });
  });
});

describe("pickerAppIdFromClientId", () => {
  it("extracts the project number", () => {
    assert.equal(pickerAppIdFromClientId("290248269800-abc.apps.googleusercontent.com"), "290248269800");
  });
  it("returns null for unexpected input", () => {
    assert.equal(pickerAppIdFromClientId("test-drive-client"), null);
    assert.equal(pickerAppIdFromClientId(undefined), null);
  });
});
