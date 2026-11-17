import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { staffUpdateSchema } from "@/lib/staff-schemas";
import { deleteStaff, updateStaff } from "@/lib/staff-service";

type Ctx = { params: Promise<{ id: string }> };

// Only staff ids are accepted here, so the owner can never be demoted or deleted through this route.
export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const actor = await requirePermission("staff.manage");
    return json(await updateStaff(actor, (await params).id, staffUpdateSchema.parse(await req.json())));
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const actor = await requirePermission("staff.manage");
    await deleteStaff(actor, (await params).id);
    return json({ ok: true });
  });
}
