import { requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { godownSchema } from "@/lib/schemas";
import { createGodown } from "@/lib/stock-service";

export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("godowns.manage");
    const { name } = godownSchema.parse(await req.json());
    await createGodown(actor, name);
    return json({ ok: true }, 201);
  });
}
