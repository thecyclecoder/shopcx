import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  try{const {data}=await a.from("function_autonomy").select("function_slug,live,autonomous").in("function_slug",["cs","retention"]);
    console.log("function_autonomy:", JSON.stringify(data)||"(no cs/retention rows → CS Director NOT activated)");}catch(e){console.log("function_autonomy:",(e as any).message);}
}
main().catch(e=>{console.error(e.message);process.exit(1);});
