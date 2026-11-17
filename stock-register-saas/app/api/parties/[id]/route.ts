import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { partySchema } from "@/lib/party-schemas";
import { deleteParty, getPartyRow, updateParty } from "@/lib/party-service";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => json(await getPartyRow(await requireActor(), (await params).id)));
}

export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    await updateParty(await requireActor(), (await params).id, partySchema.parse(await req.json()));
    return json({ ok: true });
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    await deleteParty(await requireActor(), (await params).id);
    return json({ ok: true });
  });
}
