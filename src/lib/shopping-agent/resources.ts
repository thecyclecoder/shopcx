/**
 * MCP Apps UI resources (docs/brain/libraries/shopping-agent.md · Phase 3).
 *
 * `ui://` HTML resources served with MIME `text/html;profile=mcp-app` (the MCP Apps standard), linked
 * from tools via `_meta.ui.resourceUri` (+ the `openai/outputTemplate` alias so ChatGPT renders the
 * same template). A product card (image, rating, lead benefit, price/serving, disclaimer) and a pack
 * picker that calls `build_cart`. Grok gets the same data as plain text (no UI resource).
 *
 * The HTML reads the tool's structuredContent from the MCP Apps host bridge
 * (`window.openai?.toolOutput` on ChatGPT, `window.mcpApp?.output` on Claude). It is intentionally
 * dependency-free + self-contained; the storefront checkout origin is the only allowed external link.
 */

/** The MCP Apps MIME type — the self-verify token `profile=mcp-app` lives here. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

export interface UiResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
}

const PRODUCT_CARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a}
  .cards{display:flex;flex-direction:column;gap:12px;padding:8px}
  .card{border:1px solid #e5e5e5;border-radius:12px;padding:12px;display:flex;gap:12px}
  .card img{width:88px;height:88px;object-fit:cover;border-radius:8px;background:#f3f3f3}
  .title{font-weight:600;font-size:15px}
  .rating{color:#b8860b;font-size:13px}
  .benefit{font-size:13px;color:#444;margin-top:4px}
  .price{font-size:13px;margin-top:4px}
  .disclaimer{font-size:10px;color:#888;margin-top:8px;padding:0 8px}
</style></head>
<body>
  <div class="cards" id="cards"></div>
  <div class="disclaimer" id="disclaimer"></div>
  <script>
    function output(){try{return (window.openai&&window.openai.toolOutput)||(window.mcpApp&&window.mcpApp.output)||{}}catch(e){return {}}}
    var o=output();
    var products=(o.products)||((o.matches||[]).map(function(m){return m.product}).filter(Boolean));
    var root=document.getElementById('cards');
    (products||[]).forEach(function(p){
      if(!p)return;
      var el=document.createElement('div');el.className='card';
      el.innerHTML=''
        +(p.image?'<img src="'+p.image+'" alt="">':'<div style="width:88px"></div>')
        +'<div><div class="title">'+(p.title||'')+'</div>'
        +(p.rating?'<div class="rating">★ '+p.rating+' ('+(p.review_count||0)+' reviews)</div>':'')
        +(p.lead_benefit?'<div class="benefit">'+p.lead_benefit+'</div>':'')
        +(p.price_per_serving?'<div class="price">'+p.price_per_serving+' / serving</div>':'')
        +(p.caffeine?'<div class="price">Caffeine: '+p.caffeine+'</div>':'')
        +'</div>';
      root.appendChild(el);
    });
    var d=(products&&products[0]&&products[0].disclaimer)||o.disclaimer||'';
    document.getElementById('disclaimer').textContent=d;
  </script>
</body></html>`;

const PACK_PICKER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a}
  .wrap{padding:12px}
  .row{display:flex;gap:8px;margin:8px 0}
  button{border:1px solid #d0d0d0;border-radius:8px;padding:8px 12px;background:#fff;cursor:pointer;font-size:14px}
  button.primary{background:#111;color:#fff;border-color:#111}
  .total{font-weight:600;margin:8px 0}
  a.checkout{display:inline-block;margin-top:8px;color:#0a58ca;font-size:14px}
  .disclaimer{font-size:10px;color:#888;margin-top:10px}
</style></head>
<body>
  <div class="wrap">
    <div class="row" id="tiers">
      <button data-tier="1">1 pack</button>
      <button data-tier="2">2 packs</button>
      <button data-tier="3" class="primary">3 packs (best value)</button>
    </div>
    <div class="total" id="total"></div>
    <a class="checkout" id="checkout" href="#" rel="noopener">Go to secure checkout →</a>
    <div class="disclaimer" id="disclaimer"></div>
  </div>
  <script>
    function output(){try{return (window.openai&&window.openai.toolOutput)||(window.mcpApp&&window.mcpApp.output)||{}}catch(e){return {}}}
    function callTool(name,args){
      try{if(window.openai&&window.openai.callTool)return window.openai.callTool(name,args);}catch(e){}
      try{if(window.mcpApp&&window.mcpApp.callTool)return window.mcpApp.callTool(name,args);}catch(e){}
    }
    var o=output();
    function render(cart){
      if(!cart)return;
      document.getElementById('total').textContent=cart.total?('Total: '+cart.total):'';
      var a=document.getElementById('checkout');
      if(cart.checkout_url){a.href=cart.checkout_url;a.style.display='inline-block';}else{a.style.display='none';}
      document.getElementById('disclaimer').textContent=cart.disclaimer||'';
    }
    render(o);
    document.getElementById('tiers').addEventListener('click',function(e){
      var t=e.target&&e.target.getAttribute('data-tier');
      if(!t)return;
      var r=callTool('build_cart',{product_id:o.product_id,pack_tier:Number(t),mode:'subscribe'});
      if(r&&r.then)r.then(function(res){render((res&&res.structuredContent)||res)});
    });
  </script>
</body></html>`;

export const UI_RESOURCES: UiResource[] = [
  {
    uri: "ui://shopping-agent/product-card.html",
    name: "Product card",
    description: "Product card: image, rating, lead benefit, price per serving, FDA disclaimer.",
    mimeType: MCP_APP_MIME,
    text: PRODUCT_CARD_HTML,
  },
  {
    uri: "ui://shopping-agent/pack-picker.html",
    name: "Pack picker",
    description: "Pack-tier picker that calls build_cart and links to secure checkout.",
    mimeType: MCP_APP_MIME,
    text: PACK_PICKER_HTML,
  },
];

export const UI_RESOURCES_BY_URI: Map<string, UiResource> = new Map(UI_RESOURCES.map((r) => [r.uri, r]));
