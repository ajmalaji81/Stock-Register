import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { activityQuerySchema } from "@/lib/staff-schemas";
import { listActivity } from "@/lib/staff-service";

export async function GET(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("activity.view");
    const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
    return json(await listActivity(actor, activityQuerySchema.parse(params)));
  });
}
