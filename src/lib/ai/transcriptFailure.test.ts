import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { transcriptErrorInfo } from "./transcriptFailure";

describe("transcriptErrorInfo", () => {
  it("maps a blocked server IP to transcript_blocked", () => {
    assert.deepEqual(transcriptErrorInfo("blocked"), {
      code: "transcript_blocked",
      message: "YouTube blocked automatic caption fetching from the server. Paste the transcript below to continue.",
    });
  });

  it("maps missing captions to transcript_missing", () => {
    assert.deepEqual(transcriptErrorInfo("no_captions"), {
      code: "transcript_missing",
      message: "This video has no captions. Paste the transcript below to continue.",
    });
  });

  it("maps every other reason, including none, to transcript_unavailable", () => {
    const expected = {
      code: "transcript_unavailable",
      message: "Couldn't get the transcript for this video. Paste it below to continue.",
    };
    assert.deepEqual(transcriptErrorInfo("unavailable"), expected);
    assert.deepEqual(transcriptErrorInfo("unknown"), expected);
    assert.deepEqual(transcriptErrorInfo(null), expected);
    assert.deepEqual(transcriptErrorInfo(undefined), expected);
  });
});
