-- Allow anon key to read external ticket_messages for widget Realtime
-- This enables the WebSocket subscription for chat widget
CREATE POLICY "Anon can read external messages for widget"
  ON public.ticket_messages FOR SELECT TO anon
  USING (visibility = 'external');

-- Enable Realtime on ticket_messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.ticket_messages;
