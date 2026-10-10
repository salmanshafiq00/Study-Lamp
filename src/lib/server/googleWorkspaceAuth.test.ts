import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { signWorkspaceState, verifyWorkspaceState } from "./googleWorkspaceAuth";

// The state helpers read these secrets at call time (not import time), so
// setting them here — before any test body runs — is enough. Throwaway values,
// never real credentials.
process.env.GOOGLE_WORKSPACE_OAUTH_STATE_SECRET = "test-workspace-state-secret";
process.env.GOOGLE_WORKSPACE_CLIENT_ID = "test-workspace-client";
process.env.GOOGLE_WORKSPACE_CLIENT_SECRET = "test-workspace-secret";

const NONCE = "nonce-abcdefghijklmnopqrstuvwxyz0123456789";

describe("workspace OAuth state", () => {
  it("signs and verifies a state round-trip, preserving uid and features", () => {
    const state = signWorkspaceState("user-1", NONCE, ["calendar"]);
    const verified = verifyWorkspaceState(state, NONCE);
    assert.ok(verified);
    assert.equal(verified!.uid, "user-1");
    assert.deepEqual(verified!.features, ["calendar"]);
  });

  it("rejects an expired state", () => {
    const issuedAt = 1_000_000;
    const state = signWorkspaceState("user-1", NONCE, ["tasks"], issuedAt);
    // 10 minutes + 1 ms later.
    assert.equal(verifyWorkspaceState(state, NONCE, [], issuedAt + 10 * 60 * 1000 + 1), null);
  });

  it("rejects a tampered payload", () => {
    const state = signWorkspaceState("user-1", NONCE, ["calendar"]);
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const tampered = Buffer.from(decoded.replace("user-1", "user-2")).toString("base64url");
    assert.equal(verifyWorkspaceState(tampered, NONCE), null);
  });

  it("rejects a state bound to a different nonce", () => {
    const state = signWorkspaceState("user-1", NONCE, ["calendar"]);
    assert.equal(verifyWorkspaceState(state, "a-different-nonce"), null);
    assert.equal(verifyWorkspaceState(state, null), null);
  });

  it("rejects a state whose signed features were altered", () => {
    const state = signWorkspaceState("user-1", NONCE, ["calendar"]);
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const tampered = Buffer.from(decoded.replace('["calendar"]', '["tasks"]')).toString("base64url");
    assert.equal(verifyWorkspaceState(tampered, NONCE), null);
  });

  it("rejects when the caller expected a feature the state does not carry", () => {
    const state = signWorkspaceState("user-1", NONCE, ["calendar"]);
    assert.equal(verifyWorkspaceState(state, NONCE, ["tasks"]), null);
  });
});
