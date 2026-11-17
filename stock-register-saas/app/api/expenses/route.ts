import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { expenseQuerySchema, expenseSchema } from "@/lib/party-schemas";
import { createExpense, listExpenses } from "@/lib/party-service";

export async function GET(req: Request) {
  return handle(async () => {
    const q = expenseQuerySchema.parse(Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== "")));
    return json(await listExpenses(await requireActor(), q));
  });
}

export async function POST(req: Request) {
  return handle(async () => json(await createExpense(await requireActor(), expenseSchema.parse(await req.json())), 201));
}
