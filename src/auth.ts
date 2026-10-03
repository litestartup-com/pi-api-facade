/**
 * API-key authentication for the northbound surface.
 *
 * Keys are pre-seeded from the environment (PI_FACADE_API_KEYS); there is no
 * self-provisioning race, so a 401 body must never contain the DSH-facade hint
 * string "provisions a key" (the manager would retry on it — contract-map §1).
 * Comparison is constant-time over sha256 digests (length-safe).
 */
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export const keyMatches = (provided: string | undefined, keys: readonly string[]): boolean => {
  if (provided === undefined || provided === "" || keys.length === 0) return false;
  const candidate = digest(provided);
  return keys.some((key) => {
    const known = digest(key);
    return known.length === candidate.length && timingSafeEqual(known, candidate);
  });
};

/** Extracts the x-api-key header (string or first of array, per Node header rules). */
export const apiKeyOf = (headers: Record<string, string | string[] | undefined>): string | undefined => {
  const raw = headers["x-api-key"];
  if (Array.isArray(raw)) return raw[0];
  return raw;
};
