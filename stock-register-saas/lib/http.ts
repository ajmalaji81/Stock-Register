import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { StockError } from "./engine";

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/** Wraps a route handler so thrown errors become clean JSON responses. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StockError) return json({ error: err.message, code: err.code }, err.status);
    if (err instanceof ZodError) return json({ error: err.issues[0]?.message ?? "Invalid input" }, 400);
    if (err instanceof SyntaxError) return json({ error: "Invalid JSON body" }, 400);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      return json({ error: "That name / SKU already exists" }, 409);
    console.error(err);
    return json({ error: "Something went wrong" }, 500);
  }
}
