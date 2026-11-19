import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { monthlyQuerySchema, monthlySalesReport } from "@/lib/report-service";

// Month-wise sales analysis. ?preset=last12|thisFY|lastFY|year (&year=2026) or ?from=YYYY-MM&to=YYYY-MM, optional &godownId.
// Needs reports.view; cost/profit only with costs.view.
export async function GET(req: Request) {
  return handle(async () => {
    const actor = await requireActor();
    const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
    return json(await monthlySalesReport(actor, monthlyQuerySchema.parse(params)));
  });
}
