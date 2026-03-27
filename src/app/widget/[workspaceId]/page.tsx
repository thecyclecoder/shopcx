"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface Message {
  id: string;
  direction: string;
  author_type: string;
  visibility?: string;
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
  const [articleVoted, setArticleVoted] = useState<Record<string, "up" | "down">>({});
  const [chatEnded, setChatEnded] = useState(false);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [chatList, setChatList] = useState<{ id: string; ticket_id: string; subject: string; status: string; last_message: string; updated_at: string }[]>([]);
  const [showChatList, setShowChatList] = useState(true);

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

  // Detect chat ended (escalation or closure)
  useEffect(() => {
    if (!messages.length || chatEnded) return;
    const lastAgentMsg = [...messages].reverse().find(m => m.direction === "outbound" && m.author_type === "ai");
    if (lastAgentMsg) {
      const body = (lastAgentMsg.body || "").toLowerCase();
      const isEscalated = body.includes("escalate") || body.includes("reach out to you at") || body.includes("follow up with you at") || body.includes("team will");
      if (isEscalated) setChatEnded(true);
    }
  }, [messages, chatEnded]);

  const handleNewChat = () => {
    // Clear session and start fresh
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${workspaceId}`);
    setSessionId(null);
    setTicketId(null);
    setMessages([]);
    setStarted(false);
    setChatEnded(false);
    setInput("");
    setShowChatList(false);
    setView("chat");
  };

  const loadChatList = async () => {
    const storedEmail = email || (() => {
      try { const s = localStorage.getItem(`${STORAGE_KEY_PREFIX}${workspaceId}`); return s ? JSON.parse(s).email : ""; } catch { return ""; }
    })();
    if (!storedEmail) return;
    const res = await fetch(`/api/widget/${workspaceId}/chats?email=${encodeURIComponent(storedEmail)}`);
    const data = await res.json();
    if (Array.isArray(data)) setChatList(data);
  };

  const openChat = async (chatTicketId: string, chatSessionId: string) => {
    setTicketId(chatTicketId);
    setSessionId(chatSessionId);
    setShowChatList(false);
    setStarted(true);
    setChatEnded(false);
    // Load messages for this ticket
    const res = await fetch(`/api/widget/${workspaceId}/messages?session_id=${chatSessionId}`);
    const data = await res.json();
    if (data.messages) setMessages(data.messages);
    // Save to localStorage
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${workspaceId}`, JSON.stringify({ sessionId: chatSessionId, email, name, ticketId: chatTicketId }));
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
          if (newMsg.visibility === "external") {
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
            setWaitingForReply(false);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
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
      setWaitingForReply(true);
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
        <button onClick={() => { setView("chat"); setShowChatList(true); loadChatList(); }}
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
          <div className="prose prose-sm mt-3 max-w-none text-zinc-700 [&_*]:!text-zinc-700 [&_a]:!text-indigo-600 [&_img]:!max-w-full [&_img]:!h-auto [&_video]:!max-w-full [&_video]:!h-auto [&_iframe]:!max-w-full">
            {viewingArticle.content_html ? (
              <div dangerouslySetInnerHTML={{ __html: viewingArticle.content_html }} />
            ) : (
              viewingArticle.content.split("\n\n").map((p: string, i: number) => <p key={i}>{p}</p>)
            )}
          </div>
          {articleLoading && <p className="mt-2 text-xs text-zinc-400">Loading...</p>}

          {/* Helpful vote */}
          <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-center">
            {articleVoted[viewingArticle.id] ? (
              <p className="text-xs text-zinc-500">
                {articleVoted[viewingArticle.id] === "up" ? "Glad this helped!" : "Thanks for the feedback."}
              </p>
            ) : (
              <>
                <p className="text-xs text-zinc-500">Was this article helpful?</p>
                <div className="mt-2 flex justify-center gap-3">
                  {(["up", "down"] as const).map(vote => (
                    <button key={vote} onClick={async () => {
                      setArticleVoted(prev => ({ ...prev, [viewingArticle.id]: vote }));
                      const urlParams = new URLSearchParams(window.location.search);
                      const helpSlug = urlParams.get("help_slug") || "";
                      fetch(`/api/help/${helpSlug || "default"}/feedback`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ article_id: viewingArticle.id, vote }),
                      }).catch(() => {});
                    }}
                      className={`flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                        vote === "up"
                          ? "border-zinc-200 text-zinc-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
                          : "border-zinc-200 text-zinc-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
                      }`}>
                      {vote === "up" ? "Yes" : "No"}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <button onClick={() => setView("chat")}
            className="mt-3 w-full rounded-lg py-2 text-sm font-medium text-white"
            style={{ backgroundColor: primaryColor }}>
            Still need help? Start a chat
          </button>
        </div>
      )}

      {/* Chat list view */}
      {view === "chat" && showChatList && (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <button
            onClick={handleNewChat}
            className="mb-3 w-full rounded-lg py-2.5 text-sm font-medium text-white"
            style={{ backgroundColor: primaryColor }}
          >
            Start a new chat
          </button>

          {chatList.length > 0 && (
            <>
              <p className="mb-2 text-xs font-medium text-zinc-400">Your conversations</p>
              {chatList.map(chat => (
                <button
                  key={chat.id}
                  onClick={() => openChat(chat.ticket_id, chat.id)}
                  className="mb-2 w-full rounded-lg border border-zinc-200 bg-white p-3 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50"
                >
                  <p className="text-sm font-medium text-zinc-900 line-clamp-1">{chat.subject}</p>
                  {chat.last_message && (
                    <p className="mt-1 text-xs text-zinc-500 line-clamp-1">{chat.last_message}</p>
                  )}
                  <p className="mt-1 text-[10px] text-zinc-400">
                    {new Date(chat.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                </button>
              ))}
            </>
          )}

          {chatList.length === 0 && (
            <p className="py-4 text-center text-xs text-zinc-400">No previous conversations</p>
          )}
        </div>
      )}

      {/* Chat view - Messages area */}
      {view === "chat" && !showChatList && (
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
                    <div className="prose prose-sm max-w-none break-words [overflow-wrap:anywhere] [&_a]:text-inherit [&_a]:underline" dangerouslySetInnerHTML={{ __html: msg.body }} />
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
        {/* Typing indicator */}
        {waitingForReply && !chatEnded && (
          <div className="mb-2 flex gap-2">
            <div className="rounded-2xl rounded-tl-sm bg-zinc-100 px-4 py-3">
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: "0ms" }} />
                <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: "150ms" }} />
                <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      )}

      {/* Input — only show in chat view when chat is active */}
      {view === "chat" && !showChatList && started && !chatEnded && (
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

      {/* Chat ended — escalated or closed */}
      {view === "chat" && !showChatList && chatEnded && (
        <div className="border-t border-zinc-200 px-4 py-3 text-center">
          <p className="text-xs text-zinc-500">This conversation has ended.</p>
          <div className="mt-2 flex justify-center gap-2">
            <button
              onClick={handleNewChat}
              className="rounded-full px-4 py-1.5 text-xs font-medium text-white"
              style={{ backgroundColor: primaryColor }}
            >
              New chat
            </button>
            <button
              onClick={() => { setShowChatList(true); loadChatList(); }}
              className="rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium text-zinc-600"
            >
              View history
            </button>
          </div>
        </div>
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
