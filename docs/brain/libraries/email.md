# libraries/email

Resend send wrapper. Templates: ticket reply, CSAT, invite, journey CTA, dunning (payment-update / recovery / paused), return confirmation, password reset.

**File:** `src/lib/email.ts`

## Exports

### `getResendClient` — function

```ts
async function getResendClient(workspaceId: string, /** If provided, sandbox mode will block emails to non-workspace-member addresses */ recipientEmail?: string,) : Promise<
```

### `sendInviteEmail` — function

```ts
async function sendInviteEmail({ workspaceId, workspaceName, toEmail, role, invitedByName, }: { workspaceId: string; workspaceName: string; toEmail: string; role: string; invitedByName: string; })
```

### `sendTicketReply` — function

```ts
async function sendTicketReply({ workspaceId, toEmail, subject, body, inReplyTo, agentName, workspaceName, }: { workspaceId: string; toEmail: string; subject: string; body: string; inReplyTo: string | null; agentName: string; workspaceName: string; }) : Promise<
```

### `sendCsatEmail` — function

```ts
async function sendCsatEmail({ workspaceId, toEmail, ticketSubject, csatUrl, workspaceName, }: { workspaceId: string; toEmail: string; ticketSubject: string; csatUrl: string; workspaceName: string; }) : Promise<
```

### `sendJourneyCTA` — function

```ts
async function sendJourneyCTA({ workspaceId, toEmail, customerName, journeyToken, contextMessage, workspaceName, primaryColor, subject, buttonLabel, inReplyTo, expiryHours, }: { workspaceId: string; toEmail: string; customerName: string; journeyToken: string; contextMessage?: string; workspaceName: string; primaryColor?: string; subject?: string; buttonLabel?: string; inReplyTo?: string | null; // 24 (default) shows the expiry line; pass a larger number or null // to suppress it. Live-rendered journeys (cancel) pass null since // their effective expiry is weeks and they pull fresh data on click. expiryHours?: number | null; }) : Promise<
```

### `sendDunningPaymentUpdateEmail` — function

```ts
async function sendDunningPaymentUpdateEmail({ workspaceId, toEmail, customerName, workspaceName, updateUrl, }: { workspaceId: string; toEmail: string; customerName: string | null; workspaceName: string; updateUrl: string; }) : Promise<
```

### `sendDunningRecoveryEmail` — function

```ts
async function sendDunningRecoveryEmail({ workspaceId, toEmail, customerName, workspaceName, }: { workspaceId: string; toEmail: string; customerName: string | null; workspaceName: string; }) : Promise<
```

### `sendDunningPausedEmail` — function

```ts
async function sendDunningPausedEmail({ workspaceId, toEmail, customerName, workspaceName, updateUrl, }: { workspaceId: string; toEmail: string; customerName: string | null; workspaceName: string; updateUrl: string; }) : Promise<
```

### `sendReturnConfirmationEmail` — function

```ts
async function sendReturnConfirmationEmail({ workspaceId, toEmail, customerName, orderNumber, resolutionType, }: { workspaceId: string; toEmail: string; customerName: string | null; orderNumber: string; resolutionType: string; }) : Promise<
```

## Callers

- `src/app/api/tickets/[id]/messages/route.ts`
- `src/app/api/webhooks/email/route.ts`
- `src/app/api/workspaces/[id]/crisis/[crisisId]/test/route.ts`
- `src/app/api/workspaces/[id]/integrations/resend/webhook/route.ts`
- `src/app/api/workspaces/[id]/invite/route.ts`
- `src/lib/easypost-email.ts`
- `src/lib/email-storefront.ts`
- `src/lib/escalation.ts`
- `src/lib/inngest/crisis-campaign.ts`
- `src/lib/inngest/deliver-pending-send.ts`
- `src/lib/inngest/dunning.ts`
- `src/lib/inngest/ticket-csat.ts`
- `src/lib/inngest/ticket-research.ts`
- `src/lib/inngest/unified-ticket-handler.ts`
- `src/lib/journey-delivery.ts`
- `src/lib/rules-actions.ts`
- `src/lib/workflow-executor.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
