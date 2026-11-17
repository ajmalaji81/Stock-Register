import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { deleteExpense } from "@/lib/party-service";

type Ctx = { params: Promise<{ id: string }> };

/** Only allowed on the day the expense was recorded. Needs expenses.manage. */
export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    await deleteExpense(await requireActor(), (await params).id);
    return json({ ok: true });
  });
}
