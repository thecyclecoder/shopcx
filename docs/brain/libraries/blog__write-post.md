# `src/lib/blog/write-post.ts` — the LLM blog writer

Step 2 of the auto-blog pipeline ([[../lifecycles/auto-blog-generation]]). Researches live and writes a genuinely-useful, human-voiced article in a chosen persona's voice, grounded in our proprietary product intelligence, under the anti-AI voice rules.

## Exports

| Export | Shape | Notes |
|---|---|---|
| `writePost(topic)` | `→ { title, handle, seo_title, seo_description, tags[], content_html, heroPrompt, socialPrompt, bodyImagePrompts[] }` | `topic` is the [[blog__select-topic]] bundle. |
| `pickComposition(product, existingTitles)` | `→ { focalSubject, setting, cameraAngle, light }` | Deterministic hero-scene picker (see below). |

## Model + research
- **Opus 4.8** (`claude-opus-4-8`) + the Anthropic **`web_search_20260209` server tool** — researches current framing live, grounds in the [[blog__select-topic]] intelligence (ingredients, research + citations, review phrases), writes in-persona, and emits a **delimited block** (title / handle / seo / tags / HTML + hero & social image prompts + `{{IMAGE:…}}` in-body placeholders the image step fills). Resumes through `pause_turn`.

## Anti-AI voice rules (E-E-A-T)
Bans the tells ("in today's fast-paced world", "in conclusion", "delve", "unlock", "game-changer", "navigating the world of", em-dash overuse, perfectly parallel triads, hedge-everything). Enforces burstiness, concrete numbers, sensory detail, real opinions, mild imperfection. Leans on first-hand/proprietary data ("our customers keep telling us…") and **real** citations only (never fabricated DOI/PubMed links); keeps the FDA disclaimer. Full rationale: [[../lifecycles/auto-blog-generation]] § "Making posts NOT read as AI".

## `pickComposition` — kills hero sameness
The old prompt gave the model one example scene ("e.g. on a sunlit kitchen counter") and LLMs collapse to it → every hero looked identical. Now the composition is chosen **in code** across 4 independent axes — **focal subject** (pouch / prepared drink / ingredient flat-lay / lifestyle moment), **setting** (10), **camera angle** (4), **light** (4) — decomposed mixed-radix from `seedFrom(product.handle) + existingTitles.length`. Each new post for a product advances the lowest digit (focal subject) first; the handle hash offsets the start so products don't open on the same frame. Deterministic + reproducible. The social variant mirrors the hero scene in 4:5; props stay the writer's job.

## Callers
- [[../inngest/auto-blog]] — step 2 of the daily run.

## Related
[[../lifecycles/auto-blog-generation]] · [[blog__select-topic]] · [[blog__generate-images]] · [[blog__authors]] · [[../customer-voice]]
