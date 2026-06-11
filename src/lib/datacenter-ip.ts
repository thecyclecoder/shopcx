/**
 * Datacenter / crawler IP classification for storefront bot exclusion.
 *
 * Real shoppers reach us from residential or mobile ISP networks; automated
 * crawlers — chiefly Meta's ad-review bots (AS32934, Facebook's own data
 * centers) — reach us from datacenter networks. Network origin is the only
 * signal that separates the two without false-positiving on real users who
 * happen to share a city with a data center (e.g. Fort Worth) or spoof a
 * mobile browser UA. See [[../tables/storefront_sessions]].is_bot.
 *
 * We classify the IP transiently at ingestion and persist ONLY a boolean —
 * the raw IP is never stored (the schema deliberately avoids IP PII).
 *
 * IPv4 CIDR match against a bundled range set. IPv6 (common on mobile) is not
 * matched and defaults to NOT-a-datacenter — correct, since mobile carriers
 * are real users; we only ever flag IPs we positively know are datacenters.
 *
 * The range set is intentionally focused on Meta (the crawler that actually
 * hits us) plus a few large cloud blocks. To extend, append CIDRs below —
 * order doesn't matter. Keep it conservative: a false positive deletes a real
 * customer from the funnel, so only add ranges you're sure are hosting-only.
 */

// Meta / Facebook (AS32934) — published edge ranges. These carry the
// ad-review crawler. No real consumer browses from here.
const META_RANGES = [
  "31.13.24.0/21",
  "31.13.64.0/18",
  "45.64.40.0/22",
  "66.220.144.0/20",
  "69.63.176.0/20",
  "69.171.224.0/19",
  "74.119.76.0/22",
  "102.132.96.0/20",
  "103.4.96.0/22",
  "129.134.0.0/16",
  "157.240.0.0/16",
  "173.252.64.0/18",
  "179.60.192.0/22",
  "185.60.216.0/22",
  "204.15.20.0/22",
];

// A few large cloud blocks where headless crawlers commonly run. Conservative
// on purpose — consumer traffic almost never originates from these.
const CLOUD_RANGES = [
  // AWS (sampling of the largest us-east blocks)
  "3.0.0.0/9",
  "18.204.0.0/14",
  "34.192.0.0/10",
  "52.0.0.0/11",
  "54.144.0.0/12",
  // Google Cloud
  "34.64.0.0/10",
  "35.184.0.0/13",
  // Microsoft Azure (sampling)
  "20.33.0.0/16",
  "40.64.0.0/10",
  // DigitalOcean / OVH / Hetzner / Linode (common bot hosts)
  "159.65.0.0/16",
  "165.227.0.0/16",
  "51.68.0.0/16",
  "5.9.0.0/16",
  "45.79.0.0/16",
];

const ALL_RANGES = [...META_RANGES, ...CLOUD_RANGES];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

function inCidr(ipInt: number, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const base = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  const baseInt = ipv4ToInt(base);
  if (baseInt == null) return false;
  if (bits <= 0) return true;
  if (bits >= 32) return ipInt === baseInt;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Extract the client IP from request headers. On Vercel the real client IP is
 * the first entry in x-forwarded-for; x-real-ip is the fallback.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || null;
}

/** True if the IP belongs to a known datacenter / Meta crawler network. */
export function isDatacenterIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const ipInt = ipv4ToInt(ip);
  if (ipInt == null) return false; // IPv6 or malformed → treat as real
  for (const cidr of ALL_RANGES) {
    if (inCidr(ipInt, cidr)) return true;
  }
  return false;
}
