import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { dateRangeSchema } from "@/lib/party-schemas";
import { cashbook } from "@/lib/party-service";

/** Cash-in-hand and bank balance from payments and expenses. Needs reports.view or payments.manage. */
export async function GET(req: Request) {
  return handle(async () => {
    const q = dateRangeSchema.parse(Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== "")));
    return json(await cashbook(await requireActor(), q.from, q.to));
  });
}
