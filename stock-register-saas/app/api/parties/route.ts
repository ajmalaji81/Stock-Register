import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { partyQuerySchema, partySchema } from "@/lib/party-schemas";
import { createParty, listParties } from "@/lib/party-service";

const params = (req: Request) => Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));

/** List parties with balances. Needs parties.manage or payments.manage. */
export async function GET(req: Request) {
  return handle(async () => json(await listParties(await requireActor(), partyQuerySchema.parse(params(req)))));
}

/** Create a party. Needs parties.manage. */
export async function POST(req: Request) {
  return handle(async () => json(await createParty(await requireActor(), partySchema.parse(await req.json())), 201));
}
