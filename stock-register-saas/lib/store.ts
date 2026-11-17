// One interface, two backends: the signed-in app talks to the API, the landing-page
// demo runs the same register in the browser. The UI doesn't know which it has.
import {
  demoAddGodown,
  demoDeleteItem,
  demoMovement,
  demoSaveItem,
  demoTransfer,
  matchesFilter,
  seedDemo,
  StockError,
  cloneState,
  type DemoState,
} from "./engine";
import { DEMO_LIMITS } from "./plans";
import { PERMISSIONS } from "./permissions";
import { godownSchema, itemSchema, movementSchema, transferSchema } from "./schemas";
import type { ItemInput, LedgerEntry, LedgerFilter, MovementInput, TransferInput, Workspace } from "./types";

export interface StockStore {
  load(): Promise<Workspace>;
  saveItem(input: ItemInput, id: string | null): Promise<void>;
  deleteItem(id: string): Promise<void>;
  addGodown(name: string): Promise<void>;
  renameGodown(id: string, name: string): Promise<void>;
  deleteGodown(id: string): Promise<void>;
  recordMovement(input: MovementInput): Promise<void>;
  transfer(input: TransferInput): Promise<void>;
  ledger(filter: LedgerFilter): Promise<LedgerEntry[]>;
}

/** Error carrying the API's `code` (e.g. LIMIT) so the UI can offer an upgrade. */
export class StoreError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login";
  if (!res.ok) throw new StoreError(data.error ?? `Request failed (${res.status})`, data.code);
  return data as T;
}

export const apiStore: StockStore = {
  load: () => call<Workspace>("GET", "/api/workspace"),
  saveItem: (input, id) => (id ? call("PATCH", `/api/items/${id}`, input) : call("POST", "/api/items", input)),
  deleteItem: (id) => call("DELETE", `/api/items/${id}`),
  addGodown: (name) => call("POST", "/api/godowns", { name }),
  renameGodown: (id, name) => call("PATCH", `/api/godowns/${id}`, { name }),
  deleteGodown: (id) => call("DELETE", `/api/godowns/${id}`),
  recordMovement: (input) => call("POST", "/api/movements", input),
  transfer: (input) => call("POST", "/api/transfers", input),
  ledger: (f) => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
    return call<LedgerEntry[]>("GET", `/api/ledger?${q}`);
  },
};

const DEMO_KEY = "godownbook-demo-v1";

/** Browser-only register for the landing page, saved to localStorage when available. */
export function createDemoStore(): StockStore & { reset(): void } {
  let state: DemoState = (() => {
    try {
      const raw = localStorage.getItem(DEMO_KEY);
      if (raw) return JSON.parse(raw) as DemoState;
    } catch {
      /* private mode etc. — fall through to a fresh demo */
    }
    return seedDemo();
  })();

  const save = () => {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  };

  const run = async (fn: () => DemoState) => {
    try {
      state = fn();
      save();
    } catch (e) {
      if (e instanceof StockError) throw new StoreError(e.message, e.code);
      const issue = (e as { issues?: { message: string }[] }).issues?.[0];
      throw new StoreError(issue?.message ?? (e as Error).message);
    }
  };

  return {
    async load() {
      const s = cloneState(state);
      return {
        mode: "demo",
        actor: { name: "Demo owner", role: "OWNER", isOwner: true, permissions: [...PERMISSIONS], godownIds: null, avatar: null },
        user: null,
        limits: DEMO_LIMITS,
        godowns: s.godowns,
        items: s.items.map((i) => ({ ...i, hsn: i.hsn ?? "", gstRate: i.gstRate ?? 0 })),
      };
    },
    saveItem: (input, id) => run(() => demoSaveItem(state, itemSchema.parse(input), id, DEMO_LIMITS.maxItems)),
    deleteItem: (id) => run(() => demoDeleteItem(state, id)),
    addGodown: (name) => run(() => demoAddGodown(state, godownSchema.parse({ name }).name, DEMO_LIMITS.maxGodowns)),
    renameGodown: (id, name) =>
      run(() => {
        const s = cloneState(state);
        const g = s.godowns.find((x) => x.id === id);
        if (!g) throw new StockError("Godown not found", 404);
        g.name = godownSchema.parse({ name }).name;
        for (const e of s.ledger) if (e.godownId === id) e.godownName = g.name;
        return s;
      }),
    deleteGodown: (id) =>
      run(() => {
        if (state.godowns.length <= 1) throw new StockError("You need at least one godown");
        if (state.ledger.some((e) => e.godownId === id))
          throw new StockError("This godown has ledger entries. Transfer its stock out; godowns with history can't be deleted.");
        const s = cloneState(state);
        s.godowns = s.godowns.filter((g) => g.id !== id);
        for (const it of s.items) delete it.stock[id];
        return s;
      }),
    recordMovement: (input) => run(() => demoMovement(state, movementSchema.parse(input))),
    transfer: (input) => run(() => demoTransfer(state, transferSchema.parse(input))),
    async ledger(f) {
      return cloneState(state).ledger.filter((e) => matchesFilter(e, f));
    },
    reset() {
      state = seedDemo();
      save();
    },
  };
}
