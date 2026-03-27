# Worktree: SMS Inbound via Twilio

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-sms feature/sms-inbound
cd ../shopcx-sms
npm install
```

Work in `/Users/admin/Projects/shopcx-sms` — NOT main.

## What to Build

Inbound SMS creates tickets with `channel: "sms"`. Outbound replies send via Twilio.

## Twilio Setup

### Credentials (per workspace)
- `twilio_account_sid_encrypted`
- `twilio_auth_token_encrypted`
- `twilio_phone_number` — the Twilio phone number for sending

### Webhook
Twilio sends POST to `https://shopcx.ai/api/webhooks/sms` when an SMS is received.

## Database Changes
```sql
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_account_sid_encrypted TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_auth_token_encrypted TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT;
```

## Files to Create

### `src/app/api/webhooks/sms/route.ts`
- POST: receive inbound SMS from Twilio
- Validate Twilio signature (X-Twilio-Signature header)
- Extract: From (phone), Body (message), MessageSid
- Find customer by phone number
- Create or thread ticket with `channel: "sms"`
- Fire `ai/reply-received` if AI enabled for sms channel
- Respond with TwiML `<Response></Response>` (empty, we reply async)

### `src/lib/twilio.ts`
```typescript
export async function sendSMS(workspaceId: string, to: string, body: string): Promise<{ success: boolean; error?: string }>
```
- Uses workspace's Twilio credentials
- Sends via Twilio Messages API
- Returns message SID on success

### Ticket Detail Integration
- When replying to an SMS ticket, send via Twilio instead of Resend
- Check `ticket.channel === "sms"` in the message send flow
- Customer's phone is the "address", not email

### Settings UI
- Twilio credentials input (Account SID, Auth Token, Phone Number)
- Test SMS button
- Similar pattern to Resend integration

## SMS-Specific Behavior
- SMS messages are short — AI responses should be extra concise (max 160 chars ideally, 320 max)
- Add to channel config: `max_response_length: 300` for SMS
- No HTML formatting in SMS
- Threading: by phone number (find existing open ticket for this phone)

## Testing
1. Configure Twilio credentials in settings
2. Send SMS to the Twilio number → verify ticket created
3. Reply from ShopCX → verify SMS received
4. AI auto-reply on SMS channel
5. Threading: second SMS goes to same ticket

## When Done
Push to `feature/sms-inbound` branch. Tell the merge manager (main terminal) to merge.
