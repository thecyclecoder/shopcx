import { createAdminClient } from "../src/lib/supabase/admin";
const db=createAdminClient();
const {data:m}=await db.from("ticket_messages").select("created_at,direction,visibility,author_type,body").eq("ticket_id","51649473-0725-4f35-abd9-93f829237e10").order("created_at");
for (const x of m!) console.log(x.created_at.slice(5,16),x.direction,x.visibility,x.author_type,"|",(x.body??"").slice(0,400).replace(/\n/g," "));
const {data:t}=await db.from("tickets").select("status,subject,handled_by").eq("id","51649473-0725-4f35-abd9-93f829237e10").single(); console.log(t);
