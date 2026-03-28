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
  const [formSubmitted, setFormSubmitted] = useState<Set<string>>(new Set());
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
          // Only add outbound messages from Realtime — inbound already added optimistically
          if (newMsg.visibility === "external" && newMsg.direction === "outbound") {
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
            setWaitingForReply(false);
            clearTimeout((window as unknown as Record<string, unknown>).__shopcxTypingTimer as number);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [ticketId]);


  // Auto-scroll on new messages or typing indicator
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, waitingForReply]);

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

      setSending(false);

      // Only show typing indicator if the system is actually going to respond
      if (data.expecting_reply) {
        const timer = setTimeout(() => setWaitingForReply(true), 5000);
        (window as unknown as Record<string, unknown>).__shopcxTypingTimer = timer;
      }
    } catch {
      // Remove optimistic message on failure
      setMessages((prev) => prev.filter((m) => m.id !== tempMsg.id));
      setInput(msg);
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

              // Check for journey multi-step form
              const journeyMatch = msg.body.match(/<!--JOURNEY:([\s\S]*?)-->/);
              let journeyData: { token: string; steps: { key: string; type: string; question: string; subtitle?: string; placeholder?: string; options?: { value: string; label: string }[] }[] } | null = null;
              if (journeyMatch) {
                try { journeyData = JSON.parse(journeyMatch[1]); } catch {}
              }

              // Check for interactive form in message
              const formMatch = msg.body.match(/<!--FORM:([\s\S]*?)-->/);
              let formData: { type: string; prompt: string; options: { value: string; label: string }[]; id: string } | null = null;
              let bodyWithoutForm = msg.body.replace(/<!--JOURNEY:[\s\S]*?-->/g, "").replace(/<!--FORM:[\s\S]*?-->/g, "").trim();
              if (formMatch) {
                try { formData = JSON.parse(formMatch[1]); } catch {}
              }

              return (
                <div
                  key={msg.id}
                  className={`mb-2 flex ${isCustomer ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                      isCustomer
                        ? "rounded-tr-sm text-white"
                        : "rounded-tl-sm bg-zinc-100 text-zinc-900"
                    }`}
                    style={isCustomer ? { backgroundColor: primaryColor } : undefined}
                  >
                    {bodyWithoutForm && (
                      <div
                        className="prose prose-sm max-w-none break-words [overflow-wrap:anywhere] [&_a]:text-inherit [&_a]:underline"
                        dangerouslySetInnerHTML={{ __html: bodyWithoutForm }}
                        onClick={(e) => {
                          const el = (e.target as HTMLElement).closest("[data-coupon]");
                          if (el) {
                            const code = el.getAttribute("data-coupon");
                            if (code) {
                              navigator.clipboard.writeText(code);
                              const orig = el.textContent;
                              el.textContent = "Copied!";
                              setTimeout(() => { el.textContent = orig; }, 1500);
                            }
                          }
                        }}
                      />
                    )}

                    {/* Interactive form */}
                    {formData && !formSubmitted.has(formData.id) && (
                      <InteractiveForm
                        form={formData}
                        primaryColor={primaryColor}
                        onSubmit={async (response) => {
                          setFormSubmitted(prev => new Set([...prev, formData!.id]));
                          // Send response as a message
                          const tempMsg: Message = { id: `temp-${Date.now()}`, direction: "inbound", author_type: "customer", body: response, created_at: new Date().toISOString() };
                          setMessages(prev => [...prev, tempMsg]);
                          setWaitingForReply(false);
                          try {
                            const res = await fetch(`/api/widget/${workspaceId}/messages`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ email: email.trim(), message: response, session_id: sessionId }),
                            });
                            const data = await res.json();
                            if (data.message_id) setMessages(prev => prev.map(m => m.id === tempMsg.id ? { ...m, id: data.message_id } : m));
                          } catch {}
                          setTimeout(() => setWaitingForReply(true), 5000);
                        }}
                      />
                    )}
                    {formData && formSubmitted.has(formData.id) && (
                      <p className="mt-1 text-xs text-zinc-500 italic">Response submitted</p>
                    )}

                    {/* Inline multi-step journey form */}
                    {journeyData && !formSubmitted.has(journeyData.token) && (
                      <InlineJourneyForm
                        token={journeyData.token}
                        steps={journeyData.steps}
                        primaryColor={primaryColor}
                        onComplete={async (humanResponse) => {
                          setFormSubmitted(prev => new Set([...prev, journeyData!.token]));
                          const tempMsg: Message = { id: `temp-${Date.now()}`, direction: "inbound", author_type: "customer", body: humanResponse, created_at: new Date().toISOString() };
                          setMessages(prev => [...prev, tempMsg]);
                        }}
                      />
                    )}
                    {journeyData && formSubmitted.has(journeyData.token) && (
                      <p className="mt-1 text-xs text-zinc-500 italic">Completed</p>
                    )}

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
        {/* Typing indicator — only after customer messages, never after our own */}
        {waitingForReply && !chatEnded && messages.length > 0 && messages[messages.length - 1].direction === "inbound" && (
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

      {/* Input — hide when interactive form is active */}
      {view === "chat" && !showChatList && started && !chatEnded && (() => {
        // Check for active unanswered form
        const hasActiveForm = messages.some(m => {
          const match = m.body.match(/<!--FORM:([\s\S]*?)-->/);
          if (!match) return false;
          try { const f = JSON.parse(match[1]); return !formSubmitted.has(f.id); } catch { return false; }
        });
        if (hasActiveForm) return null; // Hide input when form is active
        return true;
      })() && (
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

// Interactive form component for checklist, radio, confirm, text input
function buildHumanResponse(steps: { key: string; type: string; question: string; options?: { value: string; label: string }[] }[], responses: Record<string, { value: string; label: string }>): string {
  const parts: string[] = [];
  for (const step of steps) {
    const r = responses[step.key];
    if (!r) continue;
    if (step.key === "account_linking") {
      const selected = r.label;
      if (selected.includes("these are mine")) {
        const emails = selected.replace("Yes, these are mine: ", "").replace(". The rest are not mine.", "");
        parts.push(`Yes, ${emails} is also my email.`);
      } else {
        parts.push("None of those emails are mine.");
      }
    } else if (step.key === "consent") {
      parts.push(r.value === "Yes" ? "Add me to the email and SMS marketing list." : "No thanks on the marketing signup.");
    } else if (step.key === "phone_input") {
      parts.push(`${r.value} is my phone number.`);
    } else if (step.key === "apply_subscription") {
      parts.push(r.value === "Yes" ? "Apply the coupon to my subscription." : "I'll use the coupon at checkout instead.");
    } else {
      parts.push(r.label);
    }
  }
  return parts.join(" ");
}

function InlineJourneyForm({
  token,
  steps,
  primaryColor,
  onComplete,
}: {
  token: string;
  steps: { key: string; type: string; question: string; subtitle?: string; placeholder?: string; options?: { value: string; label: string }[] }[];
  primaryColor: string;
  onComplete: (humanResponse: string) => void;
}) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [responses, setResponses] = useState<Record<string, { value: string; label: string }>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const step = steps[currentIdx];

  const handleStepSubmit = async (value: string, label: string) => {
    const updated = { ...responses, [step.key]: { value, label } };
    setResponses(updated);

    // "No" on consent — end journey, server handles re-nudge via email
    if (step.key === "consent" && value === "No") {
      setSubmitting(true);
      await fetch(`/api/journey/${token}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "declined", responses: updated }),
      });
      setDone(true);
      setSubmitting(false);
      onComplete(buildHumanResponse(steps, updated));
      return;
    }

    if (currentIdx < steps.length - 1) {
      setCurrentIdx(i => i + 1);
      return;
    }

    // Last step — submit all
    setSubmitting(true);
    await fetch(`/api/journey/${token}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "completed", responses: updated }),
    });
    setDone(true);
    setSubmitting(false);
    onComplete(buildHumanResponse(steps, updated));
  };

  if (done) return null;
  if (!step) return null;

  const displayQuestion = step.question;
  const displaySubtitle = step.subtitle;

  return (
    <div className="mt-2">
      {steps.length > 1 && (
        <div className="mb-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-200">
            <div className="h-full rounded-full transition-all" style={{ width: `${((currentIdx + 1) / steps.length) * 100}%`, backgroundColor: primaryColor }} />
          </div>
          <span className="text-[10px] text-zinc-400">{currentIdx + 1}/{steps.length}</span>
        </div>
      )}
      <p className="mb-1.5 text-xs font-medium text-zinc-700">{displayQuestion}</p>
      {displaySubtitle && <div className="mb-2 text-[11px] text-zinc-400" dangerouslySetInnerHTML={{ __html: displaySubtitle }} />}

      {step.type === "confirm" && (
        <div className="flex gap-2">
          <button onClick={() => handleStepSubmit("Yes", "Yes, please!")} disabled={submitting}
            className="flex-1 rounded-lg py-2 text-xs font-medium text-white disabled:opacity-60" style={{ backgroundColor: primaryColor }}>
            Yes
          </button>
          <button onClick={() => handleStepSubmit("No", "No thanks")} disabled={submitting}
            className="flex-1 rounded-lg border border-zinc-200 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-60">No thanks</button>
        </div>
      )}

      {step.type === "radio" && step.options && (
        <div className="space-y-1.5">
          {step.options.map(opt => (
            <button key={opt.value} onClick={() => handleStepSubmit(opt.value, opt.label)} disabled={submitting}
              className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-xs text-zinc-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-60">
              <span className="flex h-3.5 w-3.5 shrink-0 rounded-full border border-zinc-300" />
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {step.type === "checklist" && step.options && (
        <InlineChecklist
          options={step.options}
          primaryColor={primaryColor}
          submitting={submitting}
          onSubmit={(value, label) => handleStepSubmit(value, label)}
        />
      )}

      {step.type === "text_input" && step.key.startsWith("phone") && (
        <PhoneInputForm primaryColor={primaryColor} onSubmit={(v) => handleStepSubmit(v, v)} />
      )}
    </div>
  );
}

function InlineChecklist({
  options,
  primaryColor,
  submitting,
  onSubmit,
}: {
  options: { value: string; label: string }[];
  primaryColor: string;
  submitting: boolean;
  onSubmit: (value: string, label: string) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  return (
    <div className="space-y-1.5">
      {options.map(opt => {
        const isChecked = checked.has(opt.value);
        return (
          <button key={opt.value}
            onClick={() => setChecked(prev => { const n = new Set(prev); if (n.has(opt.value)) n.delete(opt.value); else n.add(opt.value); return n; })}
            disabled={submitting}
            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-all ${
              isChecked ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-white text-zinc-700 hover:border-indigo-300"
            } disabled:opacity-60`}>
            <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
              isChecked ? "border-emerald-500 bg-emerald-500 text-white" : "border-zinc-300"
            }`}>
              {isChecked && <svg className="h-2 w-2" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
            </span>
            {opt.label}
          </button>
        );
      })}
      <button
        onClick={() => {
          const selectedLabels = options.filter(o => checked.has(o.value)).map(o => o.label);
          const remaining = options.filter(o => !checked.has(o.value));
          const label = selectedLabels.length > 0
            ? (remaining.length > 0 ? `Yes, these are mine: ${selectedLabels.join(", ")}. The rest are not mine.` : `Yes, these are mine: ${selectedLabels.join(", ")}`)
            : "None of these are mine";
          onSubmit(Array.from(checked).join(","), label);
        }}
        disabled={submitting}
        className="w-full rounded-lg py-2 text-xs font-medium text-white disabled:opacity-40"
        style={{ backgroundColor: primaryColor }}>
        {checked.size === 0 ? "None are mine" : "Continue"}
      </button>
    </div>
  );
}

function formatPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function PhoneInputForm({ primaryColor, onSubmit }: { primaryColor: string; onSubmit: (v: string) => void }) {
  const [digits, setDigits] = useState("");
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isComplete = digits.length === 10;
  const mask = "(___) ___-____";

  const displayed = (() => {
    let d = 0;
    return mask.split("").map(ch => {
      if (ch === "_" && d < digits.length) return digits[d++];
      return ch;
    }).join("");
  })();

  const cursorPos = (() => {
    let d = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === "_") { if (d >= digits.length) return i; d++; }
    }
    return mask.length;
  })();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Backspace") { e.preventDefault(); setDigits(p => p.slice(0, -1)); setError(""); }
    else if (e.key === "Enter" && isComplete) handleSubmit();
    else if (/^\d$/.test(e.key) && digits.length < 10) { e.preventDefault(); setDigits(p => p + e.key); setError(""); }
  };

  useEffect(() => { inputRef.current?.setSelectionRange(cursorPos, cursorPos); }, [digits, cursorPos]);

  const handleSubmit = async () => {
    if (!isComplete) return;
    setValidating(true); setError("");
    const e164 = `+1${digits}`;
    try {
      const res = await fetch(`/api/validate-phone?phone=${encodeURIComponent(e164)}`);
      const data = await res.json();
      if (!data.valid) { setError("Not a valid number. Please enter a valid mobile number."); setValidating(false); return; }
      if (data.lineType === "landline") { setError("Only mobile phones — no landlines. We need a mobile number for text messages."); setValidating(false); return; }
    } catch {}
    setValidating(false);
    onSubmit(e164);
  };

  return (
    <div className="mt-2 space-y-1.5">
      <input
        ref={inputRef}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={displayed}
        onKeyDown={handleKeyDown}
        onChange={() => {}}
        onFocus={() => inputRef.current?.setSelectionRange(cursorPos, cursorPos)}
        onClick={() => inputRef.current?.setSelectionRange(cursorPos, cursorPos)}
        className={`w-full rounded-lg border bg-white px-3 py-2 font-mono text-sm tracking-wider text-zinc-900 outline-none ${error ? "border-red-300" : "border-zinc-300 focus:border-indigo-400"}`}
      />
      {error && <p className="text-[11px] text-red-500">{error}</p>}
      <button
        onClick={handleSubmit}
        disabled={!isComplete || validating}
        className="w-full rounded-lg py-2 text-xs font-medium text-white disabled:opacity-40"
        style={{ backgroundColor: primaryColor }}
      >
        {validating ? "Checking..." : "Submit"}
      </button>
    </div>
  );
}

function InteractiveForm({ form, primaryColor, onSubmit }: {
  form: { type: string; prompt?: string; options?: { value: string; label: string }[]; id: string };
  primaryColor: string;
  onSubmit: (response: string) => void;
}) {
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("");
  const [textValue, setTextValue] = useState("");

  // Checklist: instant action per click, fade out confirmed items
  if (form.type === "checklist") {
    const remaining = (form.options || []).filter(o => !confirmed.has(o.value));

    // Auto-finish when all confirmed
    useEffect(() => {
      if (remaining.length === 0 && confirmed.size > 0) {
        const labels = (form.options || []).filter(o => confirmed.has(o.value)).map(o => o.label);
        onSubmit(`Yes, these are mine: ${labels.join(", ")}`);
      }
    }, [remaining.length, confirmed.size]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
      <div className="mt-2 space-y-1.5">
        {(form.options || []).map(option => (
          <button
            key={option.value}
            type="button"
            disabled={confirmed.has(option.value)}
            onClick={() => {
              setConfirmed(prev => new Set([...prev, option.value]));
              // Each check triggers the action immediately
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-all ${
              confirmed.has(option.value)
                ? "border-emerald-300 bg-emerald-50 opacity-50"
                : "border-zinc-200 bg-white text-zinc-700 hover:border-indigo-300 hover:bg-indigo-50"
            }`}
          >
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors ${
              confirmed.has(option.value)
                ? "border-emerald-500 bg-emerald-500 text-white"
                : "border-zinc-300"
            }`}>
              {confirmed.has(option.value) && (
                <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </span>
            <span className="break-words [overflow-wrap:anywhere]">{option.label}</span>
            {confirmed.has(option.value) && <span className="ml-auto text-xs text-emerald-600">Linked</span>}
          </button>
        ))}
        {remaining.length > 0 && confirmed.size > 0 && (
          <button
            onClick={() => {
              // Finish — confirmed ones are linked, remaining are rejected
              const labels = (form.options || []).filter(o => confirmed.has(o.value)).map(o => o.label);
              const rejected = remaining.map(o => o.label);
              onSubmit(labels.length > 0
                ? `Yes, these are mine: ${labels.join(", ")}. The rest are not mine.`
                : `None of these are mine`);
            }}
            className="w-full rounded-lg border border-zinc-200 py-2 text-xs text-zinc-500 hover:bg-zinc-50"
          >
            I&apos;m finished
          </button>
        )}
        {confirmed.size === 0 && (
          <button
            onClick={() => onSubmit("None of these are mine")}
            className="w-full rounded-lg border border-zinc-200 py-2 text-xs text-zinc-500 hover:bg-zinc-50"
          >
            None of these are mine
          </button>
        )}
      </div>
    );
  }

  // Confirm: Yes / No buttons
  if (form.type === "confirm") {
    return (
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => onSubmit("Yes")}
          className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors hover:opacity-90"
          style={{ backgroundColor: primaryColor }}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => onSubmit("No")}
          className="flex-1 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
        >
          No thanks
        </button>
      </div>
    );
  }

  // Radio: pick one
  if (form.type === "radio") {
    return (
      <div className="mt-2 space-y-1.5">
        {(form.options || []).map(option => (
          <button
            key={option.value}
            type="button"
            onClick={() => onSubmit(option.label)}
            className="flex w-full items-center gap-2.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:border-indigo-300 hover:bg-indigo-50"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-zinc-300" />
            <span>{option.label}</span>
          </button>
        ))}
        <button onClick={() => onSubmit("I'll skip this for now")}
          className="w-full rounded-lg border border-zinc-200 py-2 text-xs text-zinc-500 hover:bg-zinc-50">
          Skip
        </button>
      </div>
    );
  }

  // Phone input (detected by id prefix)
  if (form.id.startsWith("phone-input")) {
    return <PhoneInputForm primaryColor={primaryColor} onSubmit={onSubmit} />;
  }

  // Generic text input
  return (
    <div className="mt-2 space-y-2">
      <input
        type="text"
        value={textValue}
        onChange={(e) => setTextValue(e.target.value)}
        placeholder={form.prompt || "Type here..."}
        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400"
        onKeyDown={(e) => { if (e.key === "Enter" && textValue.trim()) onSubmit(textValue.trim()); }}
      />
      <div className="flex gap-2">
        <button onClick={() => { if (textValue.trim()) onSubmit(textValue.trim()); }}
          disabled={!textValue.trim()}
          className="flex-1 rounded-lg py-2 text-xs font-medium text-white disabled:opacity-40"
          style={{ backgroundColor: primaryColor }}>
          Submit
        </button>
        <button onClick={() => onSubmit("I'll skip this for now")}
          className="rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-500 hover:bg-zinc-50">
          Skip
        </button>
      </div>
    </div>
  );
}
