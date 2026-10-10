import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encryptApiKey } from "./aiEncryption";
import { googleConnectionSummaryFrom, resolveGoogleAccessToken, GoogleConnectionError } from "./googleConnections";

// A throwaway 32-byte key so encryptApiKey/decryptApiKey work in the test. Read
// at call time, so setting it before the test bodies run is enough.
process.env.AI_CONNECTION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const RAW_DOC = {
  googleEmail: "student@example.com",
  encryptedRefreshToken: encryptApiKey("refresh-token-1"),
  grantedScopes: ["calendar"],
  status: "active",
  calendar: { enabled: false },
  tasks: { enabled: false },
  createdAt: null,
  updatedAt: null,
  lastUsedAt: null,
};

describe("google connection summary", () => {
  it("returns exactly the safe key set and never a token or ciphertext", () => {
    const summary = googleConnectionSummaryFrom("conn-1", RAW_DOC);
    assert.deepEqual(Object.keys(summary).sort(), [
      "calendarEnabled",
      "createdAt",
      "driveGranted",
      "googleEmail",
      "grantedScopes",
      "id",
      "lastUsedAt",
      "status",
      "tasksEnabled",
    ]);
    assert.equal("encryptedRefreshToken" in summary, false);
    assert.equal("refreshToken" in summary, false);
  });

  it("reports driveGranted from the stored scopes without exposing it as a calendar/tasks scope", () => {
    const summary = googleConnectionSummaryFrom("conn-3", { ...RAW_DOC, grantedScopes: ["drive", "calendar"] });
    assert.equal(summary.driveGranted, true);
    assert.deepEqual(summary.grantedScopes, ["calendar"]);
    assert.equal(googleConnectionSummaryFrom("conn-4", RAW_DOC).driveGranted, false);
  });

  it("normalises an unknown status to active and filters non-feature scopes", () => {
    const summary = googleConnectionSummaryFrom("conn-2", {
      ...RAW_DOC,
      status: "weird",
      grantedScopes: ["calendar", "drive.file", "tasks"],
    });
    assert.equal(summary.status, "active");
    assert.deepEqual(summary.grantedScopes, ["calendar", "tasks"]);
  });
});

describe("resolveGoogleAccessToken", () => {
  it("refreshes and returns a token with the right expiry", async () => {
    const result = await resolveGoogleAccessToken(RAW_DOC, "calendar", async (token) => {
      assert.equal(token, "refresh-token-1");
      return { accessToken: "access-1", expiresIn: 3600 };
    }, 1000);
    assert.equal(result.token, "access-1");
    assert.equal(result.expiresAt, 1000 + 3600 * 1000);
  });

  it("refuses a connection whose granted scopes lack the required feature", async () => {
    await assert.rejects(
      () => resolveGoogleAccessToken(RAW_DOC, "tasks", async () => ({ accessToken: "x", expiresIn: 1 })),
      (error: unknown) => error instanceof GoogleConnectionError && error.code === "scope_missing",
    );
  });

  it("classifies a revoked/expired refresh token as invalid", async () => {
    await assert.rejects(
      () => resolveGoogleAccessToken(RAW_DOC, "calendar", async () => {
        const error: any = new Error("refresh failed");
        error.googleAuthInvalid = true;
        throw error;
      }),
      (error: unknown) => error instanceof GoogleConnectionError && error.code === "invalid",
    );
  });

  it("classifies any other refresh failure as network", async () => {
    await assert.rejects(
      () => resolveGoogleAccessToken(RAW_DOC, "calendar", async () => {
        throw new Error("boom");
      }),
      (error: unknown) => error instanceof GoogleConnectionError && error.code === "network",
    );
  });
});