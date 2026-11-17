import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { staffCreateSchema } from "@/lib/staff-schemas";
import { createStaff, listStaff } from "@/lib/staff-service";
import { effectivePlan } from "@/lib/plans";

export async function GET() {
  return handle(async () => {
    const actor = await requirePermission("staff.manage");
    return json({ staff: await listStaff(actor), plan: effectivePlan(actor.owner) });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("staff.manage");
    return json(await createStaff(actor, staffCreateSchema.parse(await req.json())), 201);
  });
}
