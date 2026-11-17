import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { itemSchema } from "@/lib/schemas";
import { deleteItem, updateItem } from "@/lib/stock-service";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const actor = await requirePermission("items.manage");
    await updateItem(actor, (await params).id, itemSchema.parse(await req.json()));
    return json({ ok: true });
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const actor = await requirePermission("items.manage");
    await deleteItem(actor, (await params).id);
    return json({ ok: true });
  });
}
