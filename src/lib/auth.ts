import { timingSafeEqual } from "node:crypto";

/** Shared-secret check for machine callers (voice provider, booking tools): `?key=` in the URL or an `x-webhook-secret` header. Fails closed. */
export function checkSecret(headers: Headers, url?: URL, secret = process.env.VOICE_WEBHOOK_SECRET): boolean {
  const got = url?.searchParams.get("key") ?? headers.get("x-webhook-secret");
  if (!secret || !got) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
