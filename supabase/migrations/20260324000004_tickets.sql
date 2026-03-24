-- Phase 3: Basic Ticketing

CREATE TABLE public.tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','chat','meta_dm','sms')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  subject TEXT,
  ai_confidence REAL,
  ai_handled BOOLEAN NOT NULL DEFAULT false,
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  first_response_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  csat_score INTEGER CHECK (csat_score >= 1 AND csat_score <= 5),
  churn_risk_resolved BOOLEAN DEFAULT false,
  tags TEXT[] DEFAULT '{}',
  email_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tickets_workspace ON public.tickets(workspace_id);
CREATE INDEX idx_tickets_workspace_status ON public.tickets(workspace_id, status);
CREATE INDEX idx_tickets_assigned ON public.tickets(assigned_to);
CREATE INDEX idx_tickets_customer ON public.tickets(customer_id);
CREATE INDEX idx_tickets_email_message_id ON public.tickets(workspace_id, email_message_id);

CREATE TABLE public.ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  visibility TEXT NOT NULL DEFAULT 'external' CHECK (visibility IN ('external','internal')),
  author_type TEXT NOT NULL CHECK (author_type IN ('customer','agent','ai','system')),
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  email_message_id TEXT,
  ai_draft BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_messages_ticket ON public.ticket_messages(ticket_id);
CREATE INDEX idx_ticket_messages_created ON public.ticket_messages(ticket_id, created_at);

-- RLS
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view tickets in their workspaces"
  ON public.tickets FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on tickets"
  ON public.tickets FOR ALL
  USING (auth.role() = 'service_role');

ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view ticket messages in their workspaces"
  ON public.ticket_messages FOR SELECT TO authenticated
  USING (
    ticket_id IN (
      SELECT id FROM public.tickets
      WHERE workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "Service role full access on ticket_messages"
  ON public.ticket_messages FOR ALL
  USING (auth.role() = 'service_role');
