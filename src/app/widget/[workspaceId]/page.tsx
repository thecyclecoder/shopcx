"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface Message {
  id: string;
  direction: string;
  author_type: string;
  body: string;
  created_at: string;
}

interface WidgetConfig {
  name: string;
  color: string;
  greeting: string;
  position: string;
}

const STORAGE_KEY_PREFIX = "shopcx_chat_";

export default function ChatWidgetPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load config
  useEffect(() => {
    fetch(`/api/widget/${workspaceId}/config`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError("Chat is not available");
        } else {
          setConfig(data);
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load chat");
        setLoading(false);
      });
  }, [workspaceId]);

  // Restore session from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${workspaceId}`);
    if (stored) {
      try {
        const data = JSON.parse(stored);
        if (data.sessionId) {
          setSessionId(data.sessionId);
          setEmail(data.email || "");
          setName(data.name || "");
          setStarted(true);
        }
      } catch {}
    }
  }, [workspaceId]);

  // Load existing messages when session restores
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/widget/${workspaceId}/messages?session_id=${sessionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.messages) setMessages(data.messages);
        if (data.ticket_id) setTicketId(data.ticket_id);
      })
      .catch(() => {});
  }, [sessionId, workspaceId]);

  // Subscribe to realtime messages
  useEffect(() => {
    if (!ticketId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`widget-ticket:${ticketId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "ticket_messages",
          filter: `ticket_id=eq.${ticketId}`,
        },
        (payload) => {
          const newMsg = payload.new as Message;
          // Only show external messages, skip customer's own (they're already in state)
          if (newMsg.direction === "outbound" || newMsg.author_type !== "customer") {
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [ticketId]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStarted(true);
    localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${workspaceId}`,
      JSON.stringify({ email: email.trim(), name: name.trim() })
    );
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = input.trim();
    if (!msg || sending) return;

    setSending(true);
    setInput("");

    // Optimistic add
    const tempMsg: Message = {
      id: `temp-${Date.now()}`,
      direction: "inbound",
      author_type: "customer",
      body: msg,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempMsg]);

    try {
      const res = await fetch(`/api/widget/${workspaceId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          message: msg,
          session_id: sessionId || undefined,
        }),
      });
      const data = await res.json();

      if (data.session_id && data.session_id !== sessionId) {
        setSessionId(data.session_id);
        localStorage.setItem(
          `${STORAGE_KEY_PREFIX}${workspaceId}`,
          JSON.stringify({
            sessionId: data.session_id,
            email: email.trim(),
            name: name.trim(),
          })
        );
      }
      if (data.ticket_id) setTicketId(data.ticket_id);

      // Replace temp message with real one
      if (data.message_id) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempMsg.id ? { ...m, id: data.message_id } : m
          )
        );
      }
    } catch {
      // Remove optimistic message on failure
      setMessages((prev) => prev.filter((m) => m.id !== tempMsg.id));
      setInput(msg);
    } finally {
      setSending(false);
    }
  };

  const primaryColor = config?.color || "#4f46e5";

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-white p-4">
        <p className="text-sm text-zinc-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white" style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 text-white shadow-sm"
        style={{ backgroundColor: primaryColor }}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-sm font-bold">
          {(config?.name || "S")[0].toUpperCase()}
        </div>
        <div>
          <p className="text-sm font-semibold">{config?.name}</p>
          <p className="text-xs opacity-80">We typically reply in a few minutes</p>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* Greeting */}
        <div className="mb-3 flex gap-2">
          <div
            className="max-w-[80%] rounded-2xl rounded-tl-sm px-3 py-2 text-sm text-white"
            style={{ backgroundColor: primaryColor }}
          >
            {config?.greeting}
          </div>
        </div>

        {!started ? (
          <form onSubmit={handleStart} className="mt-4 space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-sm font-medium text-zinc-700">Enter your details to start chatting</p>
            <input
              type="text"
              placeholder="Your name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
            />
            <input
              type="email"
              placeholder="Your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
            />
            <button
              type="submit"
              className="w-full rounded-lg px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: primaryColor }}
            >
              Start Chat
            </button>
          </form>
        ) : (
          <>
            {messages.map((msg) => {
              const isCustomer = msg.direction === "inbound" && msg.author_type === "customer";
              return (
                <div
                  key={msg.id}
                  className={`mb-2 flex ${isCustomer ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                      isCustomer
                        ? "rounded-tr-sm text-white"
                        : "rounded-tl-sm bg-zinc-100 text-zinc-900"
                    }`}
                    style={isCustomer ? { backgroundColor: primaryColor } : undefined}
                  >
                    <p className="whitespace-pre-wrap">{msg.body}</p>
                    <p className={`mt-0.5 text-[10px] ${isCustomer ? "text-white/60" : "text-zinc-400"}`}>
                      {new Date(msg.created_at).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              );
            })}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {started && (
        <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-zinc-200 px-3 py-2">
          <input
            type="text"
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 rounded-full border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
            autoFocus
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-40"
            style={{ backgroundColor: primaryColor }}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </form>
      )}

      {/* Footer */}
      <div className="border-t border-zinc-100 px-3 py-1.5 text-center">
        <a
          href="https://shopcx.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-zinc-400 hover:text-zinc-500"
        >
          Powered by ShopCX.ai
        </a>
      </div>
    </div>
  );
}
