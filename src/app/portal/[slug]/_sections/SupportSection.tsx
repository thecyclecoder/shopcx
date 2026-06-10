"use client";

/**
 * Support section — list tickets + view + reply.
 *
 * Lazy-loaded on first mount via /api/portal?route=supportList, which
 * spans the customer's linked accounts and returns their full history
 * (merge stubs hidden). Archived / do_not_reply tickets come back
 * flagged read_only — shown for reference but with no reply box. Reply
 * submission routes through supportReply which inserts a regular inbound
 * message — the unified ticket handler picks up routing (AI orchestrator
 * / agent assignment) from there.
 */

import { useEffect, useState } from "react";

interface Ticket {
  id: string;
  subject: string | null;
  status: string;
  channel: string;
  created_at: string;
  last_customer_reply_at?: string | null;
  read_only?: boolean;
}

interface Message {
  id: string;
  direction: "inbound" | "outbound";
  author_type: string;
  body: string;
  body_clean?: string | null;
  created_at: string;
}

interface Props {
  primaryColor: string;
}

export function SupportSection({ primaryColor }: Props) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => { refreshTickets(); }, []);

  async function refreshTickets() {
    setLoadingTickets(true);
    try {
      const res = await fetch("/api/portal?route=supportList", { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      setTickets((data.tickets || []) as Ticket[]);
    } catch { /* ignore */ }
    setLoadingTickets(false);
  }

  if (composing) {
    return (
      <ComposeNew
        onCancel={() => setComposing(false)}
        onCreated={async (ticketId) => {
          setComposing(false);
          await refreshTickets();
          setActiveTicketId(ticketId);
        }}
        primaryColor={primaryColor}
      />
    );
  }

  if (activeTicketId) {
    return (
      <TicketDetail
        ticketId={activeTicketId}
        onBack={() => { setActiveTicketId(null); refreshTickets(); }}
        primaryColor={primaryColor}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600">
          {tickets.length === 0 && !loadingTickets ? "No support conversations yet." : `${tickets.length} conversation${tickets.length === 1 ? "" : "s"}`}
        </p>
        <button
          type="button"
          onClick={() => setComposing(true)}
          className="rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-sm"
          style={{ backgroundColor: primaryColor }}
        >
          New message
        </button>
      </div>

      {loadingTickets ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
          Loading…
        </div>
      ) : tickets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-zinc-700">Need a hand?</p>
          <p className="mt-1 text-sm text-zinc-500">Tap &ldquo;New message&rdquo; above to start a conversation.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTicketId(t.id)}
              className="block w-full rounded-2xl border border-zinc-200 bg-white p-4 text-left transition hover:border-zinc-300 sm:p-5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="truncate text-base font-semibold text-zinc-900">
                  {t.subject || "Conversation"}
                </h3>
                <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusToneClass(t.status)}`}>
                  {humanStatus(t.status)}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {new Date(t.last_customer_reply_at || t.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                {" · "}
                {humanChannel(t.channel)}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TicketDetail({ ticketId, onBack, primaryColor }: { ticketId: string; onBack: () => void; primaryColor: string }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => { load(); }, [ticketId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/portal?route=supportTicket&ticketId=${encodeURIComponent(ticketId)}`, { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (data.ticket) setTicket(data.ticket as Ticket);
      if (data.messages) setMessages(data.messages as Message[]);
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function send() {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/portal?route=supportReply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ticketId, body: reply.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setSending(false);
        return;
      }
      setReply("");
      await load();
    } catch { /* ignore */ }
    setSending(false);
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-800"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        Back to conversations
      </button>

      {loading ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Loading…</div>
      ) : !ticket ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Conversation not found.</div>
      ) : (
        <>
          <div className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-zinc-900">{ticket.subject || "Conversation"}</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Opened {new Date(ticket.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} · {humanChannel(ticket.channel)}
            </p>
          </div>

          <div className="space-y-3">
            {messages.length === 0 ? (
              <div className="rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-500">No messages yet.</div>
            ) : (
              messages.map((m) => (
                <article
                  key={m.id}
                  className={`rounded-2xl border p-4 sm:p-5 ${m.direction === "inbound" ? "border-zinc-200 bg-zinc-50" : "border-emerald-100 bg-white"}`}
                >
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      {m.direction === "inbound" ? "You" : m.author_type === "ai" ? "Support" : m.author_type === "agent" ? "Support" : "Support"}
                    </span>
                    <span className="text-xs text-zinc-400">
                      {new Date(m.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                  </div>
                  <div
                    className="prose prose-sm max-w-none break-words text-sm leading-relaxed text-zinc-800 [&_p]:my-1.5"
                    dangerouslySetInnerHTML={{ __html: sanitizeBody(m.body_clean || m.body || "") }}
                  />
                </article>
              ))
            )}
          </div>

          {ticket.read_only ? (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-center text-sm text-zinc-500 sm:p-5">
              This conversation is closed. If you need more help, start a new request from the Support page.
            </div>
          ) : (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Reply
              </label>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={4}
                placeholder="Type your message…"
                className="mt-2 w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
              />
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={send}
                  disabled={!reply.trim() || sending}
                  className="rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
                  style={{ backgroundColor: primaryColor }}
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ComposeNew({ onCancel, onCreated, primaryColor }: { onCancel: () => void; onCreated: (ticketId: string) => void; primaryColor: string }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    if (!body.trim()) { setErr("Please write a message."); return; }
    setSending(true);
    setErr("");
    try {
      const res = await fetch("/api/portal?route=supportCreate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ticket_id) {
        setErr(data?.message || data?.error || "Could not send. Please try again.");
        setSending(false);
        return;
      }
      onCreated(data.ticket_id as string);
    } catch {
      setErr("Network error.");
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onCancel}
        className="flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-800"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        Back
      </button>

      <div className="rounded-2xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-zinc-900">New message</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Tell us what&apos;s going on — we usually get back the same day.
        </p>

        <label className="mt-5 block">
          <span className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">Subject (optional)</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What's this about?"
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
          />
        </label>

        <label className="mt-4 block">
          <span className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">Message</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder="Type your message…"
            className="mt-1 w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
          />
        </label>

        {err && <p className="mt-3 text-sm text-rose-600">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-600 hover:bg-zinc-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={sending || !body.trim()}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
            style={{ backgroundColor: primaryColor }}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function statusToneClass(status: string): string {
  if (status === "open") return "bg-emerald-50 text-emerald-700";
  if (status === "pending") return "bg-amber-50 text-amber-800";
  if (status === "closed") return "bg-zinc-100 text-zinc-600";
  return "bg-zinc-100 text-zinc-600";
}
function humanStatus(s: string): string {
  if (s === "open") return "Active";
  if (s === "pending") return "Waiting";
  if (s === "closed") return "Resolved";
  if (s === "archived") return "Closed";
  return s;
}
function humanChannel(c: string): string {
  const m: Record<string, string> = {
    email: "Email",
    chat: "Chat",
    help_center: "Help center",
    social_comments: "Social",
    meta_dm: "Messenger",
    sms: "Text",
  };
  return m[c] || c;
}

/**
 * Very light HTML sanitizer for AI/agent message bodies — strips
 * <script> and inline event handlers. Bodies from our outbound
 * pipeline are already AI-generated so this is belt-and-suspenders.
 */
function sanitizeBody(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
}
