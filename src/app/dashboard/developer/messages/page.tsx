import MessageCenterChat from "./MessageCenterChat";

// Developer > Message Center (developer-message-center). Owner-only "ask the box anything" console.
// The sidebar hides this for non-owners, the API + the client component both re-gate to role==='owner'.
export const dynamic = "force-dynamic";

export default function MessageCenterPage() {
  return <MessageCenterChat />;
}
