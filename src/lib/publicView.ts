/**
 * The dashboard is "public" when DASHBOARD_PUBLIC=true and no password is set. In that mode it must be safe for anyone with the link:
 * no transcripts, no names, no phone numbers (not even in part), no free-text reasons (they can contain names).
 * With a password set, the full view is shown to whoever knows it.
 */
export const isPublicView = (env: Record<string, string | undefined> = process.env): boolean =>
  env.DASHBOARD_PUBLIC === "true" && !env.DASHBOARD_PASSWORD;
