import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cardFromLocation,
  driveStatus,
  errorMessage,
  featureStatus,
  legacyDriveSettingsRedirect,
  messagesFromParams,
} from "./googleSettings";

describe("cardFromLocation", () => {
  it("prefers ?tab over the hash and ignores unknown values", () => {
    assert.equal(cardFromLocation("calendar", "#drive"), "calendar");
    assert.equal(cardFromLocation(null, "#drive"), "drive");
    assert.equal(cardFromLocation(null, "tasks"), "tasks");
    assert.equal(cardFromLocation("nope", "#also-nope"), null);
    assert.equal(cardFromLocation(undefined, undefined), null);
  });
});

describe("messagesFromParams", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("shows connected, missing and error messages in that order", () => {
    assert.deepEqual(messagesFromParams(params("connected=a%40b.com&missing=calendar,tasks&error=Boom")), [
      { kind: "success", text: "Connected a@b.com" },
      { kind: "error", text: "You did not allow Calendar and Tasks access, so that feature stays off." },
      { kind: "error", text: "Boom" },
    ]);
  });

  it("returns nothing when no parameters are present", () => {
    assert.deepEqual(messagesFromParams(params("")), []);
  });

  it("keeps an unknown missing feature name instead of dropping it", () => {
    assert.deepEqual(messagesFromParams(params("missing=photos")), [
      { kind: "error", text: "You did not allow photos access, so that feature stays off." },
    ]);
  });

  it("names Drive when the user unticked Drive on Google's consent screen (G5)", () => {
    assert.deepEqual(messagesFromParams(params("missing=drive")), [
      { kind: "error", text: "You did not allow Drive access, so that feature stays off." },
    ]);
  });
});

describe("card status", () => {
  it("driveStatus separates connected, needs reconnect and not connected", () => {
    assert.equal(driveStatus([]), "not_connected");
    assert.equal(driveStatus([{ status: "invalid" }]), "needs_reconnect");
    assert.equal(driveStatus([{ status: "invalid" }, { status: "active" }]), "connected");
  });

  it("featureStatus only counts connections granted that feature", () => {
    const calendarOnly = { status: "active" as const, grantedScopes: ["calendar" as const] };
    const tasksInvalid = { status: "invalid" as const, grantedScopes: ["tasks" as const] };
    assert.equal(featureStatus([calendarOnly], "calendar"), "connected");
    assert.equal(featureStatus([calendarOnly], "tasks"), "not_connected");
    assert.equal(featureStatus([calendarOnly, tasksInvalid], "tasks"), "needs_reconnect");
    assert.equal(featureStatus([], "calendar"), "not_connected");
  });
});

describe("legacyDriveSettingsRedirect", () => {
  it("lands on the Drive card and keeps callback messages", () => {
    assert.equal(legacyDriveSettingsRedirect({}), "/settings/google#drive");
    assert.equal(
      legacyDriveSettingsRedirect({ connected: "a@b.com", error: ["first", "second"], other: "x" }),
      "/settings/google?connected=a%40b.com&error=first#drive",
    );
  });
});

describe("errorMessage", () => {
  it("uses the error message, else the fallback", () => {
    assert.equal(errorMessage(new Error("bad"), "fallback"), "bad");
    assert.equal(errorMessage(new Error(""), "fallback"), "fallback");
    assert.equal(errorMessage("text", "fallback"), "fallback");
  });
});
