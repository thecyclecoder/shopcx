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

interface KBArticle {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  category: string;
  product_name: string | null;
  view_count: number;
  helpful_yes: number;
}

interface ArticleDetail {
  id: string;
  title: string;
  content: string;
  content_html: string | null;
  excerpt: string | null;
  product_name: string | null;
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
  const [articles, setArticles] = useState<KBArticle[]>([]);
  const [articleSearch, setArticleSearch] = useState("");
  const [viewingArticle, setViewingArticle] = useState<ArticleDetail | null>(null);
  const [articleLoading, setArticleLoading] = useState(false);
  const [view, setView] = useState<"articles" | "chat">("articles");

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

  // Load contextual KB articles
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const pid = urlParams.get("pid") || "";
    const handle = urlParams.get("handle") || "";
    const params = new URLSearchParams();
    if (pid) params.set("pid", pid);
    if (handle) params.set("handle", handle);
    if (articleSearch) params.set("search", articleSearch);

    fetch(`/api/widget/${workspaceId}/articles?${params}`)
      .then(r => r.json())
      .then(data => { if (data.articles) setArticles(data.articles); })
      .catch(() => {});
  }, [workspaceId, articleSearch]);

  // Load full article for inline viewing
  const openArticle = async (articleId: string) => {
    setArticleLoading(true);
    try {
      const res = await fetch(`/api/widget/${workspaceId}/articles/${articleId}`);
      const data = await res.json();
      if (data.title) setViewingArticle(data);
    } catch {}
    setArticleLoading(false);
  };

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

      {/* View switcher tabs */}
      <div className="flex border-b border-zinc-200 bg-zinc-50">
        <button onClick={() => { setView("articles"); setViewingArticle(null); }}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${view === "articles" ? "border-b-2 text-zinc-900" : "text-zinc-400"}`}
          style={view === "articles" ? { borderColor: primaryColor, color: primaryColor } : {}}>
          Help Articles
        </button>
        <button onClick={() => setView("chat")}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${view === "chat" ? "border-b-2 text-zinc-900" : "text-zinc-400"}`}
          style={view === "chat" ? { borderColor: primaryColor, color: primaryColor } : {}}>
          Chat
        </button>
      </div>

      {/* Articles view */}
      {view === "articles" && !viewingArticle && (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <input
            value={articleSearch}
            onChange={(e) => setArticleSearch(e.target.value)}
            placeholder="Search help articles..."
            className="mb-3 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 outline-none focus:border-indigo-500"
          />
          {articles.length === 0 && !articleSearch && (
            <p className="py-4 text-center text-xs text-zinc-400">No articles available</p>
          )}
          {articles.length === 0 && articleSearch && (
            <p className="py-4 text-center text-xs text-zinc-400">No articles match your search</p>
          )}
          {articles.map(a => (
            <button key={a.id} onClick={() => openArticle(a.id)}
              className="mb-2 w-full rounded-lg border border-zinc-200 bg-white p-3 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50">
              <p className="text-sm font-medium text-zinc-900">{a.title}</p>
              {a.excerpt && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{a.excerpt}</p>}
              <div className="mt-1 flex gap-2 text-xs text-zinc-400">
                {a.product_name && <span className="text-indigo-500">{a.product_name}</span>}
                {a.helpful_yes > 0 && <span>{a.helpful_yes} found helpful</span>}
              </div>
            </button>
          ))}
          <button onClick={() => setView("chat")}
            className="mt-3 w-full rounded-lg py-2 text-sm font-medium text-white"
            style={{ backgroundColor: primaryColor }}>
            Still need help? Start a chat
          </button>
        </div>
      )}

      {/* Inline article view */}
      {view === "articles" && viewingArticle && (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <button onClick={() => setViewingArticle(null)} className="mb-2 text-xs text-indigo-600 hover:underline">
            &larr; Back to articles
          </button>
          <h2 className="text-sm font-bold text-zinc-900">{viewingArticle.title}</h2>
          {viewingArticle.product_name && (
            <span className="mt-1 inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600">{viewingArticle.product_name}</span>
          )}
          <div className="prose prose-sm mt-3 max-w-none text-zinc-700 [&_*]:!text-zinc-700 [&_a]:!text-indigo-600">
            {viewingArticle.content_html ? (
              <div dangerouslySetInnerHTML={{ __html: viewingArticle.content_html }} />
            ) : (
              viewingArticle.content.split("\n\n").map((p: string, i: number) => <p key={i}>{p}</p>)
            )}
          </div>
          {articleLoading && <p className="mt-2 text-xs text-zinc-400">Loading...</p>}
          <button onClick={() => setView("chat")}
            className="mt-4 w-full rounded-lg py-2 text-sm font-medium text-white"
            style={{ backgroundColor: primaryColor }}>
            Still need help? Start a chat
          </button>
        </div>
      )}

      {/* Chat view - Messages area */}
      {view === "chat" && (
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
      )}

      {/* Input — only show in chat view */}
      {view === "chat" && started && (
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
