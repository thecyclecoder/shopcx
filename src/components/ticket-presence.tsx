"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface PresenceState {
  userId: string;
  userName: string;
  typing: boolean;
}

export function useTicketPresence({
  ticketId,
  currentUserId,
  currentUserName,
}: {
  ticketId: string;
  currentUserId: string;
  currentUserName: string;
}) {
  const [others, setOthers] = useState<PresenceState[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!currentUserId) return;
    const supabase = createClient();
    const channel = supabase.channel(`ticket-presence:${ticketId}`, {
      config: { presence: { key: currentUserId } },
    });
    channelRef.current = channel;

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const otherUsers = Object.values(state)
          .flat()
          .filter((u) => (u as unknown as PresenceState).userId !== currentUserId)
          .map((u) => u as unknown as PresenceState);
        setOthers(otherUsers);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            userId: currentUserId,
            userName: currentUserName,
            typing: false,
          });
        }
      });

    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [ticketId, currentUserId, currentUserName]);

  const setTyping = useCallback(
    (isTyping: boolean) => {
      channelRef.current?.track({
        userId: currentUserId,
        userName: currentUserName,
        typing: isTyping,
      });
    },
    [currentUserId, currentUserName]
  );

  const onEditorInput = useCallback(() => {
    setTyping(true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => setTyping(false), 3000);
  }, [setTyping]);

  const onEditorBlur = useCallback(() => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    setTyping(false);
  }, [setTyping]);

  return { others, onEditorInput, onEditorBlur };
}

function formatNames(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export default function TicketPresenceBanner({ others }: { others: PresenceState[] }) {
  if (others.length === 0) return null;

  const typing = others.filter((o) => o.typing);
  const viewing = others.filter((o) => !o.typing);

  const message =
    typing.length > 0
      ? `${formatNames(typing.map((t) => t.userName))} ${typing.length === 1 ? "is" : "are"} typing...`
      : `${formatNames(viewing.map((v) => v.userName))} ${viewing.length === 1 ? "is" : "are"} viewing this ticket`;

  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
      {message}
    </div>
  );
}
