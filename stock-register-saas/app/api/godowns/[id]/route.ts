import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { godownSchema } from "@/lib/schemas";
import { deleteGodown, renameGodown } from "@/lib/stock-service";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const actor = await requirePermission("godowns.manage");
    const { name } = godownSchema.parse(await req.json());
    await renameGodown(actor, (await params).id, name);
    return json({ ok: true });
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const actor = await requirePermission("godowns.manage");
    await deleteGodown(actor, (await params).id);
    return json({ ok: true });
  });
}
