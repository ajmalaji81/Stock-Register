import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { movementSchema } from "@/lib/schemas";
import { recordMovement } from "@/lib/stock-service";

export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("stock.move");
    await recordMovement(actor, movementSchema.parse(await req.json()));
    return json({ ok: true }, 201);
  });
}
