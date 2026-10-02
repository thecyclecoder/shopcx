(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data } = await admin
    .from("specs")
    .select(`
      id,
      slug,
      status,
      spec_phases (
        name,
        status
      )
    `)
    .eq("slug", "error-feed-drop-meta-ad-accounts-name-direct-rest-lookup-noi");

  console.log(JSON.stringify(data, null, 2));
})();
