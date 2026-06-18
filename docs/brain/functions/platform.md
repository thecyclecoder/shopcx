# Platform / Engineering (function)

The permanent owner of **the build system and the product engineering itself** — the autonomous build pipeline, the AI-agent platform, dev tooling/skills, the spec process, and store-tech integrations. The CTO-equivalent seat: not one of the CEO-mode *business* directors (Growth/CMO/Retention/CFO/Logistics/CS), but a first-class function that owns all the specs which build and operate ShopCX as software.

## Scope + owned metrics

- **Owns:** the [[../specs/roadmap-build-console|roadmap build console]] + box worker, build approval gates, the [[../specs/goal-decomposition-engine|goal-decomposition engine]], the repo skills catalog, the spec lifecycle/archival process, and Shopify/store-tech tooling.
- **North-star metrics:** specs shipped per week, build success rate, time idea→merged-PR, tsc/CI green.

## Mandates (perpetual)

### Autonomous build platform
Idea → spec → autonomous build → merged PR, phone-first, on the Max subscription — and keep making that loop faster, safer, and more capable.
- **Metric:** idea→merge cycle time, build success rate, human-touch per build trending down.
- **Specs:** [[../specs/roadmap-build-console]] ✅ · [[../specs/build-approval-gates]] ✅ · [[../specs/goal-decomposition-engine]] ⏳ · [[../specs/repo-skills-catalog]] 🚧 · [[../specs/spec-lifecycle-and-archival]] ⏳

### Store tech / Shopify
AI-driven management of the live Shopify store + theme from inside ShopCX.
- **Specs:** [[../specs/shopify-theme-via-shopcx]] ⏳

### Infra & DevOps / reliability
The "actually improve the system" work — the build box + worker ([[../recipes/build-box-setup]]), deploys, CI/tsc gates, and reliability of the platform itself. (Folded into Platform rather than a separate function; promote to its own function only if the surface grows.)
- **Metric:** build/deploy success rate, green CI, box uptime.

## Owned / contributed goals

- Enables every other function — the build platform is what turns their specs into shipped code. Underpins [[../goals/ceo-mode]] (the engine that ships the capability-gap specs the CEO surfaces).

## Status

Charter doc. Owns the autonomous build platform + store-tech tooling.
