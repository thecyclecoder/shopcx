/**
 * One-shot: send a follow-up reply on social_comment d6ebe220-...
 * The original AI reply was too vague ("berry pops in and out") and
 * missed the active crisis_event indicating Mixed Berry is expected
 * back 2026-07-09. Send a corrected reply with the actual date.
 *
 * Root-cause fix to the orchestrator is in this same commit:
 * src/lib/social-comment-orchestrator.ts now joins crisis_events on
 * shopify_variant_id, not internal UUID.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { executeAction } from "@/lib/social-comment-actions";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const SC_ID = "d6ebe220-3946-428e-9778-6f4987326124";
const REPLY = "Quick follow-up, Debi — Mixed Berry is expected back in stock around July 9th. We'll have it waiting for you then 💛";

async function main() {
  const { data: comment, error } = await sb.from("social_comments").select("*").eq("id", SC_ID).single();
  if (error || !comment) {
    console.error("could not load comment:", error);
    process.exit(1);
  }
  console.log(`Comment from ${comment.meta_sender_name}: "${comment.body}"`);
  console.log(`Original AI reply: "${comment.ai_reply_body}"`);
  console.log(`\nFollow-up to send: "${REPLY}"\n`);

  const res = await executeAction({
    admin: sb as unknown as Parameters<typeof executeAction>[0]["admin"],
    comment: comment as Parameters<typeof executeAction>[0]["comment"],
    action: "reply",
    replyBody: REPLY,
    actorUserId: null,
    moderationSource: "agent_manual",
  });
  console.log("executeAction result:", res);
}
main().catch(e=>{console.error(e);process.exit(1);});
