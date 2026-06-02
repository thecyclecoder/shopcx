# libraries/twilio-verify

Verify v2 OTP flow for customer phone verification.

**File:** `src/lib/twilio-verify.ts`

## File header

```
Twilio Verify wrapper. Verify is Twilio's purpose-built OTP service —
we don't manage codes, expiry, brute-force protection, or
deliverability routing. We just call:
verifications.create({ to, channel })   → Twilio sends the OTP
verificationChecks.create({ to, code }) → Twilio verifies it
Verify uses Twilio's high-deliverability OTP pool, which carriers
explicitly whitelist for transactional traffic. No 10DLC compliance
burden for our 888 toll-free number on the OTP path.
Per-workspace Service SID lives in workspaces.twilio_verify_service_sid.
Provisioned once via the Settings → Integrations → Twilio "Setup OTP"
action which calls `createVerifyService` below.
```

## Exports

### `createVerifyService` — function

```ts
async function createVerifyService(workspaceId: string, friendlyName: string,) : Promise<
```

### `startVerification` — function

```ts
async function startVerification(serviceSid: string, to: string, channel: "sms" | "email", customFriendlyName?: string,) : Promise<
```

### `checkVerification` — function

```ts
async function checkVerification(serviceSid: string, to: string, code: string,) : Promise<
```

## Callers

- `src/app/api/checkout/otp/resend/route.ts`
- `src/app/api/checkout/otp/start/route.ts`
- `src/app/api/checkout/otp/verify/route.ts`
- `src/app/api/portal/otp/resend/route.ts`
- `src/app/api/portal/otp/start/route.ts`
- `src/app/api/portal/otp/verify/route.ts`
- `src/app/api/workspaces/[id]/integrations/twilio-verify-setup/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
