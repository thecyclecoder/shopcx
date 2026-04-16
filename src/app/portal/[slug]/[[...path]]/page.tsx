// Catch-all route for portal sub-paths (e.g. /portal/superfoods/subscriptions, /portal/superfoods/subscription?id=123)
// Re-exports the main portal page so client-side routing works on direct URL hits
export { default } from "../page";
