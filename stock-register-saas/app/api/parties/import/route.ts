import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { partyImportSchema } from "@/lib/party-schemas";
import { importParties } from "@/lib/party-service";

/**
 * Bulk-create parties. Body: { rows: [{ name, type, phone, email, gstin, state, address, openingBalance }] }
 * (column names are matched loosely). Returns { created, errors: [{ row, error }] }. Needs parties.manage.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const { rows } = partyImportSchema.parse(await req.json());
    return json(await importParties(await requireActor(), rows));
  });
}
