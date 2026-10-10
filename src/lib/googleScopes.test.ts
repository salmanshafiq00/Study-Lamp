import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_USERINFO_EMAIL_SCOPE,
  GOOGLE_WORKSPACE_SCOPES,
  featuresFromGrantedScopes,
  googleFeaturesFromGrantedScopes,
  missingFeatures,
  missingGoogleFeatures,
  scopesForFeatures,
  scopesForGoogleFeatures,
} from "./googleScopes";

describe("googleScopes", () => {
  it("builds the scope list for a feature and always includes userinfo.email", () => {
    assert.deepEqual(scopesForFeatures(["calendar"]), [
      GOOGLE_WORKSPACE_SCOPES.calendar,
      GOOGLE_USERINFO_EMAIL_SCOPE,
    ]);
  });

  it("de-duplicates features and keeps a stable order", () => {
    assert.deepEqual(scopesForFeatures(["tasks", "calendar", "tasks"]), [
      GOOGLE_WORKSPACE_SCOPES.tasks,
      GOOGLE_WORKSPACE_SCOPES.calendar,
      GOOGLE_USERINFO_EMAIL_SCOPE,
    ]);
  });

  it("returns only userinfo.email when no feature is requested", () => {
    assert.deepEqual(scopesForFeatures([]), [GOOGLE_USERINFO_EMAIL_SCOPE]);
  });

  it("parses granted features from a space-separated scope string", () => {
    const scope = `${GOOGLE_WORKSPACE_SCOPES.calendar} ${GOOGLE_USERINFO_EMAIL_SCOPE}`;
    assert.deepEqual(featuresFromGrantedScopes(scope), ["calendar"]);
  });

  it("ignores unknown scopes and handles null/empty input", () => {
    assert.deepEqual(featuresFromGrantedScopes(null), []);
    assert.deepEqual(featuresFromGrantedScopes(""), []);
    assert.deepEqual(featuresFromGrantedScopes("https://www.googleapis.com/auth/drive.file"), []);
  });

  it("reports which requested features were not granted (partial grant)", () => {
    const scope = GOOGLE_WORKSPACE_SCOPES.calendar;
    assert.deepEqual(missingFeatures(["calendar", "tasks"], scope), ["tasks"]);
    assert.deepEqual(missingFeatures(["calendar"], scope), []);
  });
});

describe("Drive aware scope helpers (G5)", () => {
  it("requests only drive.file for Drive, plus the email scope", () => {
    assert.deepEqual(scopesForGoogleFeatures(["drive"]), [GOOGLE_DRIVE_SCOPE, GOOGLE_USERINFO_EMAIL_SCOPE]);
    assert.equal(GOOGLE_DRIVE_SCOPE, "https://www.googleapis.com/auth/drive.file");
  });

  it("orders scopes stably, removes duplicates and ignores unknown features", () => {
    const scopes = scopesForGoogleFeatures(["tasks", "drive", "drive", "calendar", "nope" as never]);
    assert.deepEqual(scopes, [GOOGLE_DRIVE_SCOPE, GOOGLE_WORKSPACE_SCOPES.calendar, GOOGLE_WORKSPACE_SCOPES.tasks, GOOGLE_USERINFO_EMAIL_SCOPE]);
  });

  it("never asks for a wide Drive scope", () => {
    for (const scope of scopesForGoogleFeatures(["drive", "calendar", "tasks"])) {
      assert.ok(!/auth\/drive$|drive\.readonly|drive\.appdata|drive\.metadata/.test(scope), scope);
    }
  });

  it("reads Drive from the granted scope string, and ignores unknown scopes", () => {
    assert.deepEqual(googleFeaturesFromGrantedScopes(`${GOOGLE_DRIVE_SCOPE} ${GOOGLE_WORKSPACE_SCOPES.tasks} openid`), ["drive", "tasks"]);
    assert.deepEqual(googleFeaturesFromGrantedScopes(null), []);
    assert.deepEqual(googleFeaturesFromGrantedScopes("https://www.googleapis.com/auth/drive"), []);
  });

  it("reports a partial grant: user unticked Drive", () => {
    const granted = `${GOOGLE_WORKSPACE_SCOPES.calendar} ${GOOGLE_USERINFO_EMAIL_SCOPE}`;
    assert.deepEqual(missingGoogleFeatures(["drive", "calendar"], granted), ["drive"]);
    assert.deepEqual(missingGoogleFeatures(["calendar"], granted), []);
  });

  it("leaves the Calendar/Tasks-only helpers unchanged", () => {
    assert.deepEqual(scopesForFeatures(["calendar"]), [GOOGLE_WORKSPACE_SCOPES.calendar, GOOGLE_USERINFO_EMAIL_SCOPE]);
    assert.deepEqual(featuresFromGrantedScopes(`${GOOGLE_DRIVE_SCOPE} ${GOOGLE_WORKSPACE_SCOPES.tasks}`), ["tasks"]);
  });
});
