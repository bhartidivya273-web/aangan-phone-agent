export const dash = "—";

export function fmtSec(s: number | null): string {
  if (s === null) return dash;
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function fmtMin(m: number | null): string {
  if (m === null) return dash;
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
}

export const fmtPct = (p: number | null) => (p === null ? dash : `${p % 1 === 0 ? p : p.toFixed(1)}%`);

export function fmtInr(n: number | null): string {
  if (n === null) return dash;
  return `₹${n >= 100000 ? n.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : n.toLocaleString("en-IN", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
}

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: n < 10 ? 3 : 2, maximumFractionDigits: n < 10 ? 3 : 2 })}`;
}

export function fmtWhen(iso: string, tzOffsetMinutes = 330): string {
  const d = new Date(new Date(iso).getTime() + tzOffsetMinutes * 60_000);
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const h = d.getUTCHours();
  return `${d.getUTCDate()} ${m}, ${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}
