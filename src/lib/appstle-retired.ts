/**
 * The `appstle_retired` switch — "Appstle is gone; never call it again".
 *
 * Dylan is uninstalling the Appstle app. After that every Appstle API call fails, so:
 *
 *  - every revive / change of a never-migrated Appstle sub is rebuilt on ShopCX from OUR OWN
 *    `subscriptions` mirror row ([[commerce__shopcx-revive]] `ensureShopcxEngine`), and
 *  - every Appstle wrapper that a missed path still reaches throws `AppstleRetiredError` instead of
 *    sending a request to a vendor that no longer holds the contract — a missed path fails LOUDLY.
 *
 * ## Where the switch lives
 *
 * A row in [[../tables/kill_switches]] keyed `node_id = 'appstle_retired'`. That table's polarity
 * is "a row means the node is switched OFF", so a row here means **the Appstle engine is switched
 * off — retired**. MISSING ROW ⇒ Appstle is live, which is today's behaviour: production does not
 * change until Dylan writes the row.
 *
 * ⚠️ Only the node's OWN row counts. The kill-switch resolver cascades an ancestor's row down, but
 * a CEO freezing a department must never silently re-route billing engines, so this reads the
 * table directly (via `loadKillSwitchMap`, the table's read SDK) and checks one key.
 *
 * Fail-open, like the table itself: a read error means "not retired" — Appstle calls then go out
 * and fail on their own if Appstle is really gone, which is loud rather than silent.
 */

import { errText } from "@/lib/error-text";

/** The kill_switches.node_id whose presence means "Appstle is retired". */
export const APPSTLE_RETIRED_SWITCH = "appstle_retired";

/** Thrown by every Appstle wrapper once the switch is on. */
export class AppstleRetiredError extends Error {
  readonly code = "appstle_retired";
  constructor(where: string) {
    super(
      `appstle_retired: Appstle is retired (kill_switches.appstle_retired is set) — refusing the Appstle call in ${where}. ` +
        `Route this through the commerce SDK, which rebuilds the subscription on ShopCX from our mirror.`,
    );
    this.name = "AppstleRetiredError";
  }
}

export function isAppstleRetiredError(e: unknown): e is AppstleRetiredError {
  return e instanceof AppstleRetiredError || (e as { code?: string } | null)?.code === "appstle_retired";
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: boolean } | null = null;
let override: boolean | null = null;

/** Test-only: force the switch on/off without a DB. `null` restores the real read. */
export function _setAppstleRetiredForTests(value: boolean | null): void {
  override = value;
  cache = null;
}

/** Drop the cached value (e.g. right after writing the switch row from a script). */
export function invalidateAppstleRetiredCache(): void {
  cache = null;
}

/** Is the `appstle_retired` switch on? Cached for 30s per process. */
export async function isAppstleRetired(): Promise<boolean> {
  if (override !== null) return override;
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  let value = false;
  try {
    const { loadKillSwitchMap } = await import("@/lib/control-tower/kill-switch-resolver");
    const map = await loadKillSwitchMap();
    value = map.has(APPSTLE_RETIRED_SWITCH);
  } catch (e) {
    // Fail-open (see header). Logged so a broken read is visible.
    console.warn(`[appstle-retired] switch read failed, treating Appstle as live: ${errText(e)}`);
    value = false;
  }
  cache = { at: now, value };
  return value;
}

/** Throw `AppstleRetiredError` when the switch is on. Call before ANY Appstle request. */
export async function assertAppstleLive(where: string): Promise<void> {
  if (await isAppstleRetired()) throw new AppstleRetiredError(where);
}
