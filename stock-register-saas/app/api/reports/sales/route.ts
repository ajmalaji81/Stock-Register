import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { salesReportSchema } from "@/lib/voucher-schemas";
import { salesReport } from "@/lib/voucher-service";

// Sales / purchase register, GST summary by rate & HSN, B2B vs B2C, profit. Needs reports.view (+ costs.view for purchases).
export async function GET(req: Request) {
  return handle(async () => {
    const actor = await requireActor();
    const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
    return json(await salesReport(actor, salesReportSchema.parse(params)));
  });
}
