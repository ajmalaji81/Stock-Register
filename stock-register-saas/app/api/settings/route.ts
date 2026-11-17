import { requireActor, requirePermission } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { settingsSchema } from "@/lib/voucher-schemas";
import { profileOf, updateProfile } from "@/lib/voucher-service";

// Any signed-in actor may read the business profile (needed for bills); only settings.manage may change it.
export async function GET() {
  return handle(async () => json(profileOf((await requireActor()).owner)));
}

// Fields left out of the body keep their saved values (the schema's defaults would otherwise blank them).
export async function PUT(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("settings.manage");
    const body: unknown = await req.json();
    const sent = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const merged = { ...profileOf(actor.owner), ...Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined)) };
    return json(await updateProfile(actor, settingsSchema.parse(merged)));
  });
}
