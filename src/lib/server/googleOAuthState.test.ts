import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getStateSecret, requireStateSecret, signWithPrefix, signaturesMatch, STATE_PREFIX } from "./googleOAuthState";
import { signWorkspaceState, verifyWorkspaceState } from "./googleWorkspaceAuth";

const NONCE = Buffer.alloc(32, 9).toString("base64url");

function withEnv(values: Record<string, string>, run: () => void) {
  const names = ["GOOGLE_OAUTH_STATE_SECRET", "GOOGLE_WORKSPACE_OAUTH_STATE_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

describe("state secret lookup", () => {
  it("prefers GOOGLE_OAUTH_STATE_SECRET, then the old Workspace name", () => {
    assert.equal(getStateSecret({ GOOGLE_OAUTH_STATE_SECRET: "shared", GOOGLE_WORKSPACE_OAUTH_STATE_SECRET: "w" }), "shared");
    assert.equal(getStateSecret({ GOOGLE_WORKSPACE_OAUTH_STATE_SECRET: "w" }), "w");
  });

  it("ignores the removed GOOGLE_DRIVE_OAUTH_STATE_SECRET (G7)", () => {
    assert.equal(getStateSecret({ GOOGLE_DRIVE_OAUTH_STATE_SECRET: "d" }), null);
  });

  it("returns null for missing or blank values and trims whitespace", () => {
    assert.equal(getStateSecret({}), null);
    assert.equal(getStateSecret({ GOOGLE_OAUTH_STATE_SECRET: "   " }), null);
    assert.equal(getStateSecret({ GOOGLE_OAUTH_STATE_SECRET: "  s  " }), "s");
  });

  it("names the variable but never a value when it throws", () => {
    assert.throws(() => requireStateSecret({}), (error: unknown) => error instanceof Error && error.message.includes("GOOGLE_OAUTH_STATE_SECRET"));
  });

  it("signs with the prefix: a different prefix gives a different signature", () => {
    const a = signWithPrefix("s", STATE_PREFIX, "payload");
    const b = signWithPrefix("s", "other|", "payload");
    assert.notEqual(a, b);
    assert.equal(signaturesMatch(a, a), true);
    assert.equal(signaturesMatch(a, b), false);
  });
});

describe("signed Google state", () => {
  it("round-trips with the shared secret and carries the drive feature", () => {
    withEnv({ GOOGLE_OAUTH_STATE_SECRET: "s" }, () => {
      const state = signWorkspaceState("user-1", NONCE, ["drive"]);
      assert.deepEqual(verifyWorkspaceState(state, NONCE, ["drive"])?.features, ["drive"]);
      assert.equal(verifyWorkspaceState(state, NONCE, ["calendar"]), null);
    });
  });

  it("a state signed with another secret never verifies", () => {
    let foreign = "";
    withEnv({ GOOGLE_OAUTH_STATE_SECRET: "secret-A" }, () => { foreign = signWorkspaceState("user-1", NONCE, ["tasks"]); });
    withEnv({ GOOGLE_OAUTH_STATE_SECRET: "secret-B" }, () => {
      assert.equal(verifyWorkspaceState(foreign, NONCE), null);
    });
  });

  it("a state without the workspace prefix does not verify", () => {
    withEnv({ GOOGLE_OAUTH_STATE_SECRET: "s" }, () => {
      const payload = JSON.stringify({ uid: "user-1", nonce: NONCE, features: ["drive"], ts: Date.now() });
      const unprefixed = Buffer.from(`${payload}.${signWithPrefix("s", "", payload)}`).toString("base64url");
      assert.equal(verifyWorkspaceState(unprefixed, NONCE), null);
    });
  });
});
