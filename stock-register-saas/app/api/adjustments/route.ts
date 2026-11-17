import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { adjustmentSchema } from "@/lib/staff-schemas";
import { listAdjustments, recordAdjustment } from "@/lib/staff-service";

export async function GET() {
  return handle(async () => {
    const actor = await requirePermission("stock.adjust");
    return json(await listAdjustments(actor));
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("stock.adjust");
    return json(await recordAdjustment(actor, adjustmentSchema.parse(await req.json())), 201);
  });
}
