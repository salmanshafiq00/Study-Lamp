import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getGoogleClient, pickerAppIdFromClientId } from "./googleClientConfig";

describe("getGoogleClient", () => {
  it("uses the shared GOOGLE_CLIENT_* names", () => {
    assert.deepEqual(getGoogleClient({ GOOGLE_CLIENT_ID: "shared-id", GOOGLE_CLIENT_SECRET: "shared-secret" }), { clientId: "shared-id", clientSecret: "shared-secret" });
  });

  it("prefers the shared names over the old Workspace names", () => {
    const env = { GOOGLE_CLIENT_ID: "shared-id", GOOGLE_CLIENT_SECRET: "shared-secret", GOOGLE_WORKSPACE_CLIENT_ID: "w", GOOGLE_WORKSPACE_CLIENT_SECRET: "ws" };
    assert.deepEqual(getGoogleClient(env), { clientId: "shared-id", clientSecret: "shared-secret" });
  });

  it("still reads the old Workspace names when the shared pair is missing", () => {
    assert.deepEqual(getGoogleClient({ GOOGLE_WORKSPACE_CLIENT_ID: "w", GOOGLE_WORKSPACE_CLIENT_SECRET: "ws" }), { clientId: "w", clientSecret: "ws" });
  });

  it("ignores the removed GOOGLE_DRIVE_* names (G7)", () => {
    assert.equal(getGoogleClient({ GOOGLE_DRIVE_CLIENT_ID: "d", GOOGLE_DRIVE_CLIENT_SECRET: "ds" }), null);
  });

  it("returns null for partial pairs and trims whitespace", () => {
    assert.equal(getGoogleClient({ GOOGLE_CLIENT_ID: "only-id" }), null);
    assert.equal(getGoogleClient({}), null);
    assert.deepEqual(getGoogleClient({ GOOGLE_CLIENT_ID: " a ", GOOGLE_CLIENT_SECRET: " b " }), { clientId: "a", clientSecret: "b" });
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
