import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
const PAGE="2431731276838642";
(async()=>{
  const res=await fetch(`${BASE}/api/winners/advertiser/${PAGE}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${KEY}`},body:JSON.stringify({country:"US"})});
  console.log("HTTP", res.status, "content-type:", res.headers.get("content-type"));
  const text=await res.text();
  console.log("raw (first 800 chars):\n", text.slice(0,800));
})().then(()=>process.exit(0));
