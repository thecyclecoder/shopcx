/**
 * Shortlink slug generator. Crockford-base32 alphabet (no 0/O/1/I/L/U
 * ambiguity), 6 chars. ~1 billion namespace per workspace; collisions
 * caught by the unique constraint on (workspace_id, slug) — caller
 * should retry on the rare hit.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateShortlinkSlug(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}
