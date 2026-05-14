-- Rebuild the per-profile rolling-window summary from raw events.
-- Called by the Inngest backfill function and (later) the nightly
-- delta cron. Idempotent — re-runs are safe.
--
-- Identity join: customer_id is resolved by matching profile email
-- (case-insensitive) against customers.email. Phone fallback follows
-- only when email is missing on the Klaviyo side — we don't have
-- profile-level email stored in klaviyo_profile_events yet, so the
-- identity columns (email, phone, customer_id) start NULL and get
-- backfilled by a separate identity-resolution step.

CREATE OR REPLACE FUNCTION rebuild_engagement_summary(p_workspace_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO profile_engagement_summary (
    workspace_id, klaviyo_profile_id,
    clicked_sms_30d, clicked_sms_60d, clicked_sms_180d,
    opened_email_30d, opened_email_60d, opened_email_180d,
    clicked_email_30d, clicked_email_60d,
    viewed_product_30d, viewed_product_90d,
    added_to_cart_30d, added_to_cart_90d,
    checkout_started_30d, checkout_started_90d,
    active_on_site_30d, active_on_site_90d,
    last_clicked_sms_at, last_opened_email_at, last_clicked_email_at,
    last_viewed_product_at, last_added_to_cart_at, last_checkout_started_at,
    last_active_on_site_at,
    last_synced_at, updated_at
  )
  SELECT
    workspace_id,
    klaviyo_profile_id,

    COUNT(*) FILTER (WHERE metric_name = 'Clicked SMS' AND datetime >= NOW() - INTERVAL '30 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Clicked SMS' AND datetime >= NOW() - INTERVAL '60 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Clicked SMS' AND datetime >= NOW() - INTERVAL '180 days'),

    COUNT(*) FILTER (WHERE metric_name = 'Opened Email' AND datetime >= NOW() - INTERVAL '30 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Opened Email' AND datetime >= NOW() - INTERVAL '60 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Opened Email' AND datetime >= NOW() - INTERVAL '180 days'),

    COUNT(*) FILTER (WHERE metric_name = 'Clicked Email' AND datetime >= NOW() - INTERVAL '30 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Clicked Email' AND datetime >= NOW() - INTERVAL '60 days'),

    COUNT(*) FILTER (WHERE metric_name = 'Viewed Product' AND datetime >= NOW() - INTERVAL '30 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Viewed Product' AND datetime >= NOW() - INTERVAL '90 days'),

    COUNT(*) FILTER (WHERE metric_name = 'Added to Cart' AND datetime >= NOW() - INTERVAL '30 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Added to Cart' AND datetime >= NOW() - INTERVAL '90 days'),

    COUNT(*) FILTER (WHERE metric_name = 'Checkout Started' AND datetime >= NOW() - INTERVAL '30 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Checkout Started' AND datetime >= NOW() - INTERVAL '90 days'),

    COUNT(*) FILTER (WHERE metric_name = 'Active on Site' AND datetime >= NOW() - INTERVAL '30 days'),
    COUNT(*) FILTER (WHERE metric_name = 'Active on Site' AND datetime >= NOW() - INTERVAL '90 days'),

    MAX(datetime) FILTER (WHERE metric_name = 'Clicked SMS'),
    MAX(datetime) FILTER (WHERE metric_name = 'Opened Email'),
    MAX(datetime) FILTER (WHERE metric_name = 'Clicked Email'),
    MAX(datetime) FILTER (WHERE metric_name = 'Viewed Product'),
    MAX(datetime) FILTER (WHERE metric_name = 'Added to Cart'),
    MAX(datetime) FILTER (WHERE metric_name = 'Checkout Started'),
    MAX(datetime) FILTER (WHERE metric_name = 'Active on Site'),

    NOW(),
    NOW()
  FROM klaviyo_profile_events
  WHERE workspace_id = p_workspace_id
  GROUP BY workspace_id, klaviyo_profile_id

  ON CONFLICT (workspace_id, klaviyo_profile_id) DO UPDATE SET
    clicked_sms_30d = EXCLUDED.clicked_sms_30d,
    clicked_sms_60d = EXCLUDED.clicked_sms_60d,
    clicked_sms_180d = EXCLUDED.clicked_sms_180d,
    opened_email_30d = EXCLUDED.opened_email_30d,
    opened_email_60d = EXCLUDED.opened_email_60d,
    opened_email_180d = EXCLUDED.opened_email_180d,
    clicked_email_30d = EXCLUDED.clicked_email_30d,
    clicked_email_60d = EXCLUDED.clicked_email_60d,
    viewed_product_30d = EXCLUDED.viewed_product_30d,
    viewed_product_90d = EXCLUDED.viewed_product_90d,
    added_to_cart_30d = EXCLUDED.added_to_cart_30d,
    added_to_cart_90d = EXCLUDED.added_to_cart_90d,
    checkout_started_30d = EXCLUDED.checkout_started_30d,
    checkout_started_90d = EXCLUDED.checkout_started_90d,
    active_on_site_30d = EXCLUDED.active_on_site_30d,
    active_on_site_90d = EXCLUDED.active_on_site_90d,
    last_clicked_sms_at = EXCLUDED.last_clicked_sms_at,
    last_opened_email_at = EXCLUDED.last_opened_email_at,
    last_clicked_email_at = EXCLUDED.last_clicked_email_at,
    last_viewed_product_at = EXCLUDED.last_viewed_product_at,
    last_added_to_cart_at = EXCLUDED.last_added_to_cart_at,
    last_checkout_started_at = EXCLUDED.last_checkout_started_at,
    last_active_on_site_at = EXCLUDED.last_active_on_site_at,
    last_synced_at = NOW(),
    updated_at = NOW();
END;
$$;
