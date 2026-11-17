import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { ledgerQuerySchema } from "@/lib/schemas";
import { listLedger } from "@/lib/stock-service";

// Any signed-in actor may read the ledger for the godowns they can access (the dashboard needs it).
export async function GET(req: Request) {
  return handle(async () => {
    const actor = await requireActor();
    const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
    return json(await listLedger(actor, ledgerQuerySchema.parse(params)));
  });
}
