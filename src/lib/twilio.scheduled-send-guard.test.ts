/**
 * sendSMS scheduled-send guard — a SendAt with no Messaging Service must be
 * refused before any Twilio call, never falling back to an immediate send.
 *
 * Twilio only honours SendAt through a Messaging Service; a scheduled text sent
 * from a bare From number sends immediately, which at the reminder's 13:00 UTC
 * run is 7-8 AM local — a breach of the CEO's 9 AM-local legal rule.
 *
 * Run: npm run test:twilio-scheduled-send-guard
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Force the no-credentials path so the "guard passed" cases return the creds
// error instead of making a real network call — the guard is proven without a
// Twilio account or any fetch mocking.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

import { sendSMS } from "./twilio";

const GUARD_ERROR = "scheduled_send_requires_messaging_service";
const future = new Date(Date.now() + 60 * 60 * 1000); // 1h out

test("SendAt with no messagingServiceSid is refused without calling Twilio", async () => {
  const res = await sendSMS("ws-1", "+15551234567", "body", { sendAt: future });
  assert.equal(res.success, false);
  assert.equal(res.error, GUARD_ERROR);
});

test("SendAt with empty-string messagingServiceSid is refused", async () => {
  const res = await sendSMS("ws-1", "+15551234567", "body", {
    sendAt: future,
    messagingServiceSid: "",
  });
  assert.equal(res.success, false);
  assert.equal(res.error, GUARD_ERROR);
});

test("SendAt WITH a messagingServiceSid passes the guard (falls through to creds check)", async () => {
  const res = await sendSMS("ws-1", "+15551234567", "body", {
    sendAt: future,
    messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  });
  // Guard did NOT fire — it reached the credentials check (unset above), proving
  // a scheduled send WITH a Messaging Service is allowed through.
  assert.equal(res.success, false);
  assert.notEqual(res.error, GUARD_ERROR);
});

test("an immediate send (no sendAt) is never blocked by the scheduled-send guard", async () => {
  const res = await sendSMS("ws-1", "+15551234567", "body", {});
  assert.notEqual(res.error, GUARD_ERROR);
});
