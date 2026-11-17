import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { dateRangeSchema } from "@/lib/party-schemas";
import { partyLedger } from "@/lib/party-service";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return handle(async () => {
    const q = dateRangeSchema.parse(Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== "")));
    return json(await partyLedger(await requireActor(), (await params).id, q.from, q.to));
  });
}
