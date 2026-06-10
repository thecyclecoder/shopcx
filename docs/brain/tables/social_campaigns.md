# social_campaigns

Operator-declared social promos / seasonal campaigns — how an admin tells the scheduler "we're running a July-4th promo." See [[../lifecycles/social-scheduler]].

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `workspace_id` | uuid | → [[workspaces]] |
| `name` | text | e.g. "July 4th" |
| `starts_on`, `ends_on` | date | the promo window |
| `brief` | text | offer / angle / CTA — flows into caption generation as `campaignBrief` |
| `emphasis_product_id` | uuid | → [[products]] (optional) |
| `boost_per_platform_per_day` | int | optional: raise the daily cap during the window |
| `active` | bool | default true |

## How it's used

The planner, for each scheduled date, loads the active campaign whose window contains that date (`active=true`, `starts_on <= date <= ends_on`), passes `brief` into `generateCaption` (captions lean into the promo), and uses `boost_per_platform_per_day` to lift the per-platform daily cap for the window. Managed in **Marketing › Social** (promos panel).

## Related

[[../lifecycles/social-scheduler]] · [[scheduled_social_posts]] · [[../README]]
