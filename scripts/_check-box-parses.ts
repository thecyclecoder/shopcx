/**
 * Predeploy guard: the box's tsx entrypoints must PARSE under esbuild — the actual
 * runtime parser the box uses — not just `tsc`.
 *
 * THE INCIDENT this exists to prevent: an unescaped backtick inside a template
 * literal in `scripts/builder-worker.ts` (the box's systemd entrypoint, run via
 * `tsx` → esbuild) prematurely closed the literal. esbuild rejected it
 * ("Expected ']' but found ...") and the worker crash-looped for ~5 hours. But
 * `npx tsc --noEmit` — the pre-merge gate — ACCEPTED it, because tsc and esbuild
 * are DIFFERENT parsers with different template-literal handling. tsc alone is
 * insufficient for tsx-run box code: the pre-merge gate must validate with the
 * box's ACTUAL parser too.
 *
 * WHAT IT DOES: runs esbuild in BUNDLE mode (`platform: node`) over every box tsx
 * entrypoint, with a plugin that externalizes node_modules + any non-resolvable
 * specifier — so esbuild walks the WHOLE transitive FIRST-PARTY source tree and
 * parses every file, without needing real deps, env, or a running DB. Output is
 * discarded (`write: false`) — this is parse-only, the box code is NEVER executed.
 * ANY esbuild parse/transform error fails the check with a clear message.
 *
 * Wired into `predeploy` (`npm run check:box-parses`) so this bug class fails CI
 * red, not silently at box runtime.
 *
 * Read-only by construction: reads source, parses, discards. Never mutates state,
 * never runs the bundled code.
 */
import { build } from "esbuild";
import { existsSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "..");

// Every tsx entrypoint the box actually launches. Sources:
//   • systemd unit `/etc/systemd/system/shopcx-builder.service`
//     → ExecStart=/usr/bin/tsx scripts/builder-worker.ts  (the crash-looped one)
//   • the worker + its agents spawn these via `npx tsx scripts/<x>.ts`:
//     spec-test-* (browser-check / db-probe / sandbox), improve-box-tools,
//     seed-product-tools.
// Adding a new `tsx scripts/<x>.ts` the box runs? Add it to BOTH this list AND
// the `include` array in tsconfig.box.json — `scripts/_check-box-entrypoints-in-sync.ts`
// (chained into predeploy) asserts the two lists are set-equal, so drift fails CI red.
const BOX_ENTRYPOINTS = [
  "scripts/builder-worker.ts",
  "scripts/spec-test-browser-check.ts",
  "scripts/spec-test-db-probe.ts",
  "scripts/spec-test-sandbox.ts",
  "scripts/improve-box-tools.ts",
  "scripts/seed-product-tools.ts",
  "scripts/box-watchdog.ts", // box crash-loop watchdog — its own systemd timer entrypoint (box-crash-loop-watchdog)
];

function fail(msg: string): never {
  console.error(`\n❌ check-box-parses — ${msg}\n`);
  process.exit(1);
}

/**
 * esbuild plugin: keep the bundle to FIRST-PARTY source only. Any import that is
 * a bare package specifier, or any path that doesn't resolve to a real file on
 * disk, is marked `external` (esbuild won't try to read/parse it). The effect:
 * esbuild parses every first-party `.ts`/`.tsx` reachable from the entrypoint
 * (the whole transitive tree the box would load) without needing installed deps
 * or env. This is what surfaces a syntax error in ANY first-party file, not just
 * the entrypoint itself.
 */
const externalizeUnresolvable = {
  name: "externalize-unresolvable",
  setup(b: import("esbuild").PluginBuild) {
    b.onResolve({ filter: /.*/ }, (args) => {
      // Entry points have no importer — let esbuild resolve them normally.
      if (args.kind === "entry-point") return undefined;
      // Bare specifier (node builtin or node_modules package) → external.
      const isRelative = args.path.startsWith(".") || args.path.startsWith("/");
      if (!isRelative) return { path: args.path, external: true };
      // Relative/absolute path that resolves to a real first-party file → bundle
      // it (so it gets parsed). Try the path and common TS extensions / index.
      const base = resolve(args.resolveDir, args.path);
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.mjs`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
        `${base}/index.js`,
      ];
      const hit = candidates.find((c) => existsSync(c) && !c.endsWith("/"));
      if (hit) return { path: hit };
      // Non-resolvable first-party path (e.g. a `@/...` alias esbuild can't map,
      // or a missing file) → external so the PARSE of everything else proceeds.
      // We're checking syntax, not module resolution; the sibling `check:box-types`
      // gate (scripts/_check-box-types.ts + tsconfig.box.json) genuinely typechecks
      // the same BOX_ENTRYPOINTS list under tsc — that's what covers missing
      // imports, wrong-arity calls, and wrong-property references.
      return { path: args.path, external: true };
    });
  },
};

async function parseEntry(rel: string): Promise<{ rel: string; ok: boolean; error?: string }> {
  const abs = resolve(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    return { rel, ok: false, error: `entrypoint not found at ${abs} — update BOX_ENTRYPOINTS in this check.` };
  }
  try {
    await build({
      entryPoints: [abs],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false, // parse-only — NEVER emit, NEVER run the box code
      logLevel: "silent",
      // `@/...` etc. are externalized by the plugin; declare tsconfig so esbuild
      // reads the same compiler options the box's tsx run sees.
      tsconfig: resolve(REPO_ROOT, "tsconfig.json"),
      plugins: [externalizeUnresolvable],
      absWorkingDir: REPO_ROOT,
    });
    return { rel, ok: true };
  } catch (e) {
    const err = e as { errors?: Array<{ text: string; location?: { file: string; line: number; column: number; lineText?: string } }>; message?: string };
    if (err.errors && err.errors.length) {
      const lines = err.errors.map((x) => {
        const loc = x.location ? ` (${x.location.file}:${x.location.line}:${x.location.column})` : "";
        const ctx = x.location?.lineText ? `\n      ${x.location.lineText.trim()}` : "";
        return `${x.text}${loc}${ctx}`;
      });
      return { rel, ok: false, error: lines.join("\n    ") };
    }
    return { rel, ok: false, error: err.message || String(e) };
  }
}

async function main() {
  const results = await Promise.all(BOX_ENTRYPOINTS.map(parseEntry));
  const failures = results.filter((r) => !r.ok);

  if (failures.length > 0) {
    console.error(`\n❌ check-box-parses — ${failures.length} box entrypoint(s) FAILED esbuild parse:\n`);
    for (const f of failures) {
      console.error(`  • ${f.rel}`);
      console.error(`    ${f.error}\n`);
    }
    console.error(
      `These files are run on the box via tsx (esbuild) — \`tsc --noEmit\` may ACCEPT\n` +
      `code that esbuild REJECTS (e.g. an unescaped backtick inside a template literal),\n` +
      `crash-looping the worker. Fix the syntax error above before merging.\n`,
    );
    process.exit(1);
  }

  console.log(`✓ check-box-parses — ${results.length} box tsx entrypoint(s) esbuild-parse clean (full first-party tree):`);
  for (const r of results) console.log(`  • ${r.rel}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
