import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { loadWorkspace } from "@/lib/stock-service";

export async function GET() {
  return handle(async () => json(await loadWorkspace(await requireActor())));
}
