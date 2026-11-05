import { test } from "node:test";
import assert from "node:assert/strict";
import { supportEndReason } from "../src/supportEndReason.ts";

test("launch failures show the endpoint's explanation", () => {
  const why = "Remote support could not start: No one is signed in to this computer's desktop right now.";
  assert.equal(supportEndReason({ reason: "launch_failed", launchSummary: why }), why);
  assert.equal(
    supportEndReason({ reason: "launch_failed", launchSummary: null }),
    "The endpoint could not start the support helper.",
  );
});

test("known, unknown and missing reasons", () => {
  assert.match(supportEndReason({ reason: "launch_consent_timeout" }), /two minutes/);
  assert.equal(supportEndReason({ reason: "invalid_frame" }), "The session ended (invalid frame).");
  assert.equal(supportEndReason({ reason: null }), "");
  assert.equal(supportEndReason(undefined), "");
});
