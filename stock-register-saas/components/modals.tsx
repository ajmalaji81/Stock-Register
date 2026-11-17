"use client";

import { useState, type FormEvent } from "react";
import { todayISO } from "@/lib/engine";
import type { Godown, Item, ItemInput, Scope } from "@/lib/types";
import { Button, Field, Input, Modal, Select, money, qty } from "./ui";

export interface ModalBase {
  busy: boolean;
  error: string | null;
  onClose: () => void;
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="flex items-start gap-2 rounded-xl border-2 border-out/60 bg-out/10 px-3 py-2 text-sm font-medium text-out shadow-[inset_0_1px_0_rgb(255_255_255/0.6)]"><span aria-hidden className="font-bold">!</span>{error}</p>;
}

const GST_RATES = [0.25, 3, 5, 12, 18, 28];

const UNITS = ["pcs", "kg", "g", "ltr", "ml", "box", "Bag", "Tin", "dozen", "pack", "mtr"];

export function ItemModal({
  item,
  godowns,
  scope,
  onSave,
  ...base
}: ModalBase & { item: Item | null; godowns: Godown[]; scope: Scope; onSave: (input: ItemInput) => void }) {
  const [f, setF] = useState({
    name: item?.name ?? "",
    sku: item?.sku ?? "",
    category: item?.category ?? "",
    unit: item?.unit ?? "pcs",
    purchasePrice: String(item?.purchasePrice ?? ""),
    salePrice: String(item?.salePrice ?? ""),
    minStockAlert: String(item?.minStockAlert ?? ""),
    hsn: item?.hsn ?? "",
    gstRate: String(item?.gstRate ?? ""),
    openingQty: "",
    openingGodownId: scope !== "ALL" ? scope : godowns[0]?.id ?? "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({
      name: f.name,
      sku: f.sku,
      category: f.category,
      unit: f.unit,
      purchasePrice: Number(f.purchasePrice || 0),
      salePrice: Number(f.salePrice || 0),
      minStockAlert: Number(f.minStockAlert || 0),
      hsn: f.hsn,
      gstRate: Number(f.gstRate || 0),
      ...(item ? {} : { openingQty: Number(f.openingQty || 0), openingGodownId: f.openingGodownId }),
    });
  };

  return (
    <Modal title={item ? "Edit item" : "New item"} onClose={base.onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Item name">
          <Input required autoFocus value={f.name} onChange={set("name")} placeholder="Basmati Rice 25kg" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU / Barcode">
            <Input required value={f.sku} onChange={set("sku")} placeholder="GR-25KG" />
          </Field>
          <Field label="Category">
            <Input value={f.category} onChange={set("category")} placeholder="Grains" />
          </Field>
          <Field label="Unit">
            <Input required list="units" value={f.unit} onChange={set("unit")} />
            <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
          </Field>
          <Field label="Min. stock alert">
            <Input type="number" min="0" step="any" inputMode="decimal" value={f.minStockAlert} onChange={set("minStockAlert")} placeholder="10" />
          </Field>
          <Field label="Purchase price (₹)">
            <Input type="number" min="0" step="any" inputMode="decimal" value={f.purchasePrice} onChange={set("purchasePrice")} placeholder="0" />
          </Field>
          <Field label="Sale price (₹)">
            <Input type="number" min="0" step="any" inputMode="decimal" value={f.salePrice} onChange={set("salePrice")} placeholder="0" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="HSN / SAC code">
            <Input value={f.hsn} onChange={set("hsn")} placeholder="1006" inputMode="numeric" />
          </Field>
          <Field label="GST rate">
            <Select value={f.gstRate} onChange={set("gstRate")}>
              <option value="">No GST / exempt</option>
              {GST_RATES.map((r) => <option key={r} value={String(r)}>{r}%</option>)}
            </Select>
          </Field>
        </div>
        {!item && (
          <div className="well grid grid-cols-2 gap-3 rounded-xl p-3">
            <Field label="Opening stock">
              <Input type="number" min="0" step="any" inputMode="decimal" value={f.openingQty} onChange={set("openingQty")} placeholder="0" />
            </Field>
            <Field label="In godown">
              <Select value={f.openingGodownId} onChange={set("openingGodownId")}>
                {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {item && <p className="text-xs text-ink/60">Stock quantity can only change through Stock IN / OUT / Transfer entries, so the ledger always adds up.</p>}
        <ErrorLine error={base.error} />
        <Button type="submit" disabled={base.busy} className="w-full py-3 text-base">{base.busy ? "Saving…" : "Save item"}</Button>
      </form>
    </Modal>
  );
}

export function StockModal({
  type,
  items,
  godowns,
  scope,
  initialItemId,
  onSave,
  ...base
}: ModalBase & {
  type: "IN" | "OUT";
  items: Item[];
  godowns: Godown[];
  scope: Scope;
  initialItemId?: string;
  onSave: (input: { itemId: string; godownId: string; type: "IN" | "OUT"; qty: number; rate: number; party: string; remarks: string; date: string }) => void;
}) {
  const firstItem = items.find((i) => i.id === initialItemId) ?? items[0];
  const [itemId, setItemId] = useState(firstItem?.id ?? "");
  const [godownId, setGodownId] = useState(scope !== "ALL" ? scope : godowns[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [rate, setRate] = useState(String(firstItem ? (type === "IN" ? firstItem.purchasePrice : firstItem.salePrice) : ""));
  const [party, setParty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [date, setDate] = useState(todayISO());

  const item = items.find((i) => i.id === itemId);
  const available = item ? item.stock[godownId] ?? 0 : 0;
  const isIn = type === "IN";

  const pickItem = (id: string) => {
    setItemId(id);
    const it = items.find((i) => i.id === id);
    if (it) setRate(String(isIn ? it.purchasePrice : it.salePrice));
  };

  if (items.length === 0) {
    return (
      <Modal title={isIn ? "Stock IN" : "Stock OUT"} onClose={base.onClose}>
        <p className="text-sm">Add an item first, then record stock against it.</p>
      </Modal>
    );
  }

  return (
    <Modal title={isIn ? "+ Stock IN (purchase / receipt)" : "− Stock OUT (sale / issue)"} onClose={base.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ itemId, godownId, type, qty: Number(q), rate: Number(rate || 0), party, remarks, date });
        }}
        className="space-y-3"
      >
        <Field label="Item">
          <Select value={itemId} onChange={(e) => pickItem(e.target.value)}>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Godown" hint={item ? `In stock here: ${qty(available)} ${item.unit}` : undefined}>
            <Select value={godownId} onChange={(e) => setGodownId(e.target.value)}>
              {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={`Quantity${item ? ` (${item.unit})` : ""}`}>
            <Input type="number" required autoFocus min="0" step="any" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Rate (₹)" hint={q && rate ? `Amount: ${money(Number(q) * Number(rate))}` : undefined}>
            <Input type="number" min="0" step="any" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        </div>
        <Field label={isIn ? "Supplier" : "Customer"}>
          <Input value={party} onChange={(e) => setParty(e.target.value)} placeholder={isIn ? "Gupta Traders" : "Walk-in customer"} />
        </Field>
        <Field label="Remarks">
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Bill no., vehicle no., notes" />
        </Field>
        <ErrorLine error={base.error} />
        <Button type="submit" variant={isIn ? "in" : "out"} disabled={base.busy} className="w-full py-3 text-base">
          {base.busy ? "Saving…" : isIn ? "Add to stock" : "Remove from stock"}
        </Button>
      </form>
    </Modal>
  );
}

export function TransferModal({
  items,
  godowns,
  scope,
  onSave,
  ...base
}: ModalBase & {
  items: Item[];
  godowns: Godown[];
  scope: Scope;
  onSave: (input: { itemId: string; fromGodownId: string; toGodownId: string; qty: number; date: string; remarks: string }) => void;
}) {
  const from0 = scope !== "ALL" ? scope : godowns[0]?.id ?? "";
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [fromId, setFromId] = useState(from0);
  const [toId, setToId] = useState(godowns.find((g) => g.id !== from0)?.id ?? "");
  const [q, setQ] = useState("");
  const [date, setDate] = useState(todayISO());
  const [remarks, setRemarks] = useState("");
  const item = items.find((i) => i.id === itemId);

  if (godowns.length < 2 || items.length === 0) {
    return (
      <Modal title="Transfer between godowns" onClose={base.onClose}>
        <p className="text-sm">You need at least two godowns and one item to transfer stock. Add a godown from the Godowns tab.</p>
      </Modal>
    );
  }

  return (
    <Modal title="⇄ Transfer between godowns" onClose={base.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ itemId, fromGodownId: fromId, toGodownId: toId, qty: Number(q), date, remarks });
        }}
        className="space-y-3"
      >
        <Field label="Item">
          <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" hint={item ? `Available: ${qty(item.stock[fromId] ?? 0)} ${item.unit}` : undefined}>
            <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
              {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
          <Field label="To">
            <Select value={toId} onChange={(e) => setToId(e.target.value)}>
              {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
          <Field label={`Quantity${item ? ` (${item.unit})` : ""}`}>
            <Input type="number" required autoFocus min="0" step="any" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Date">
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Remarks">
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Vehicle no., reason" />
        </Field>
        <ErrorLine error={base.error} />
        <Button type="submit" disabled={base.busy || fromId === toId} className="w-full py-3 text-base">
          {fromId === toId ? "Pick two different godowns" : base.busy ? "Saving…" : "Transfer stock"}
        </Button>
      </form>
    </Modal>
  );
}
