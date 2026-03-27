-- Fix journey_id FK to point to journey_definitions instead of chat_journeys
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_journey_id_fkey;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_journey_id_fkey
  FOREIGN KEY (journey_id) REFERENCES public.journey_definitions(id) ON DELETE SET NULL;
