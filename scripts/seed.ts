/**
 * npm run seed [-- --reset]
 * Writes ~200 synthetic calls (provider = "demo", phones 99999...) into Supabase so the dashboard has something to show.
 * --reset deletes earlier demo rows first (the delete trigger allows provider = 'demo' only; real declined/escalated
 * calls stay undeletable). Requires migrations 0001 and 0002 to have been applied.
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { getConfig } from "../src/lib/config";
import { DEMO_PHONE_PREFIX, generateDemoData } from "../src/lib/demo";

loadEnv({ path: ".env.local" });
loadEnv();

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local)");
  const db = createClient(url, key, { auth: { persistSession: false } });
  const check = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };

  if (process.argv.includes("--reset")) {
    const { data: old, error } = await db.from("calls").select("id").eq("provider", "demo");
    check("find demo calls", error);
    const ids = (old ?? []).map((r) => r.id as string);
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      check("delete costs", (await db.from("costs").delete().in("call_id", part)).error);
      check("delete handoffs", (await db.from("handoffs").delete().in("call_id", part)).error);
      check("delete calls", (await db.from("calls").delete().in("id", part)).error);
    }
    check("delete demo leads", (await db.from("leads").delete().like("phone_normalized", `${DEMO_PHONE_PREFIX}%`)).error);
    console.log(`removed ${ids.length} earlier demo calls`);
  }

  const d = generateDemoData(new Date(), getConfig());
  const chunk = async (table: string, rows: object[]) => {
    for (let i = 0; i < rows.length; i += 200) check(`insert ${table}`, (await db.from(table).insert(rows.slice(i, i + 200))).error);
  };
  await chunk("leads", d.leads);
  await chunk("calls", d.calls.map((c) => ({ ...c })));
  await chunk("handoffs", d.handoffs);
  await chunk("costs", d.costs.map(({ id: _id, ...c }) => c));
  console.log(`seeded ${d.calls.length} calls, ${d.leads.length} leads, ${d.handoffs.length} handoffs, ${d.costs.length} cost rows (all marked demo)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
