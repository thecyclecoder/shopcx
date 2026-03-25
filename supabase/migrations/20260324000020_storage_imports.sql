-- Allow authenticated users to upload to imports bucket
CREATE POLICY "Authenticated users can upload imports"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'imports');

CREATE POLICY "Authenticated users can read imports"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'imports');

-- Service role can delete (cleanup after processing)
CREATE POLICY "Service role can delete imports"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'imports' AND auth.role() = 'service_role');
