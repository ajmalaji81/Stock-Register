import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { itemSchema } from "@/lib/schemas";
import { createItem } from "@/lib/stock-service";

export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("items.manage");
    await createItem(actor, itemSchema.parse(await req.json()));
    return json({ ok: true }, 201);
  });
}
