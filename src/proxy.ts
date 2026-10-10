import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Access control for the pages that show caller numbers and transcripts.
 *  - DASHBOARD_PASSWORD set: HTTP Basic auth (any username) on everything matched here.
 *  - DASHBOARD_PUBLIC=true (explicit opt-out, no password): the dashboard is open to anyone with the URL. The simulator is
 *    NOT opened, because it spends LLM quota; it answers 404 in production and stays available on a developer machine.
 *  - Neither: closed (503) in production, open on a developer machine.
 * The webhooks have their own authentication and are not matched here.
 */
export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  const isSimulator = req.nextUrl.pathname.startsWith("/simulator") || req.nextUrl.pathname.startsWith("/api/simulator");
  const production = process.env.NODE_ENV === "production";

  if (!password) {
    if (process.env.DASHBOARD_PUBLIC === "true") {
      if (isSimulator && production) return new NextResponse("The simulator is disabled on the public site.", { status: 404 });
      return NextResponse.next();
    }
    if (!production) return NextResponse.next();
    return new NextResponse("DASHBOARD_PASSWORD is not set; this page is closed. (Set DASHBOARD_PUBLIC=true to open the dashboard without a password.)", { status: 503 });
  }

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const given = decoded.slice(decoded.indexOf(":") + 1);
    const a = Buffer.from(given);
    const b = Buffer.from(password);
    if (a.length === b.length && timingSafeEqual(a, b)) return NextResponse.next();
  }
  return new NextResponse("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="Aangan Studio"' } });
}

export const config = { matcher: ["/dashboard/:path*", "/simulator/:path*", "/api/simulator/:path*"] };
