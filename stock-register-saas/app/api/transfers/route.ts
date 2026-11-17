import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { transferSchema } from "@/lib/schemas";
import { transferStock } from "@/lib/stock-service";

export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("stock.transfer");
    await transferStock(actor, transferSchema.parse(await req.json()));
    return json({ ok: true }, 201);
  });
}
