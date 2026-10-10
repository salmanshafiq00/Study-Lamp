import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { GoogleOAuthError, isGoogleAuthInvalid, refreshToken } from "./googleOAuth";

const CLIENT = { clientId: "id", clientSecret: "secret", redirectPath: "/api/google/auth/callback" };
const realFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("refreshToken error flags", () => {
  for (const status of [400, 401]) {
    it(`flags ${status} as an invalid grant on both flag names`, async () => {
      stubFetch(status);
      await assert.rejects(
        () => refreshToken("rt", CLIENT),
        (error: unknown) =>
          error instanceof GoogleOAuthError &&
          error.status === status &&
          error.googleAuthInvalid === true &&
          error.driveAuthInvalid === true,
      );
    });
  }

  for (const status of [403, 429, 500, 503]) {
    it(`does not flag ${status} as invalid (transient or other failure)`, async () => {
      stubFetch(status);
      await assert.rejects(
        () => refreshToken("rt", CLIENT),
        (error: unknown) =>
          error instanceof GoogleOAuthError &&
          error.status === status &&
          error.googleAuthInvalid === false &&
          error.driveAuthInvalid === false,
      );
    });
  }

  it("never puts the token or secrets in the error message", async () => {
    stubFetch(400, { error: "invalid_grant", error_description: "secret-body" });
    await assert.rejects(
      () => refreshToken("my-refresh-token", CLIENT),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes("my-refresh-token") &&
        !error.message.includes("secret") &&
        !error.message.includes("invalid_grant"),
    );
  });

  it("returns the access token on success", async () => {
    stubFetch(200, { access_token: "at", expires_in: 3600, token_type: "Bearer" });
    assert.deepEqual(await refreshToken("rt", CLIENT), { accessToken: "at", expiresIn: 3600 });
  });
});

describe("isGoogleAuthInvalid", () => {
  it("accepts either legacy flag and rejects everything else", () => {
    assert.equal(isGoogleAuthInvalid({ googleAuthInvalid: true }), true);
    assert.equal(isGoogleAuthInvalid({ driveAuthInvalid: true }), true);
    assert.equal(isGoogleAuthInvalid({ googleAuthInvalid: false, driveAuthInvalid: false }), false);
    assert.equal(isGoogleAuthInvalid(new Error("x")), false);
    assert.equal(isGoogleAuthInvalid(null), false);
    assert.equal(isGoogleAuthInvalid("boom"), false);
  });
});
