"use client";

import { useEffect, useState } from "react";
import { toCsv } from "@/lib/engine";
import { api } from "../staff/api";
import { Badge, Button, Card, Empty, Field, Input, SectionHeader, Select, downloadCsv } from "../ui";
import type { SectionProps } from "./types";

interface ActivityRow {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  detail: string;
  createdAt: string;
}
interface ActivityPage {
  total: number;
  page: number;
  size: number;
  items: ActivityRow[];
  actors: { id: string; name: string }[];
}

const AREAS: [string, string][] = [
  ["", "All actions"],
  ["stock.", "Stock IN / OUT / transfer / adjust"],
  ["item.", "Items"],
  ["godown.", "Godowns"],
  ["voucher.", "Bills & documents"],
  ["party.", "Parties"],
  ["payment.", "Payments"],
  ["expense.", "Expenses"],
  ["staff.", "Staff"],
  ["settings.", "Settings"],
];

const ACTION_LABELS: Record<string, string> = {
  "stock.in": "Stock IN",
  "stock.out": "Stock OUT",
  "stock.transfer": "Transfer",
  "stock.adjust": "Adjustment",
  "item.create": "Item added",
  "item.update": "Item edited",
  "item.delete": "Item deleted",
  "item.import": "Items imported",
  "godown.create": "Godown added",
  "godown.rename": "Godown renamed",
  "godown.delete": "Godown deleted",
  "staff.create": "Staff added",
  "staff.update": "Staff changed",
  "staff.delete": "Staff removed",
  "voucher.create": "Bill / document created",
  "voucher.cancel": "Bill cancelled",
  "voucher.convert": "Document converted",
  "voucher.edit": "Invoice edited (owner)",
  "party.create": "Party added",
  "party.update": "Party edited",
  "party.delete": "Party deleted",
  "party.import": "Parties imported",
  "payment.create": "Payment recorded",
  "payment.reverse": "Payment reversed",
  "expense.create": "Expense added",
  "expense.delete": "Expense deleted",
  "settings.update": "Settings changed",
  "profile.update": "Profile picture changed",
  "auth.password_reset": "Password reset by email",
};

export function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const [area, verb = ""] = action.split(".");
  return `${area.charAt(0).toUpperCase()}${area.slice(1)} ${verb}`.trim();
}

function tone(action: string): "in" | "out" | "low" | "ink" {
  if (action === "stock.in" || action.endsWith(".create") || action.endsWith(".import")) return "in";
  if (action === "stock.out" || action.endsWith(".delete")) return "out";
  if (action === "stock.adjust") return "low";
  return "ink";
}

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

export default function ActivitySection({ version }: SectionProps) {
  const [actorId, setActorId] = useState("");
  const [area, setArea] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ActivityPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = (p: number, size = 100) =>
    new URLSearchParams(Object.entries({ actorId, action: area, from, to, page: String(p), size: String(size) }).filter(([, v]) => v) as [string, string][]);

  useEffect(() => {
    let live = true;
    api<ActivityPage>("GET", `/api/activity?${query(page)}`)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, area, from, to, page, version]);

  async function exportCsv() {
    try {
      const all = await api<ActivityPage>("GET", `/api/activity?${query(1, 500)}`);
      downloadCsv(
        `activity-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv([["When", "Who", "Action", "Details"], ...all.items.map((r) => [new Date(r.createdAt).toLocaleString("en-IN"), r.actorName, actionLabel(r.action), r.detail])]),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const groups: [string, ActivityRow[]][] = [];
  for (const r of data?.items ?? []) {
    const d = dayLabel(r.createdAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === d) last[1].push(r);
    else groups.push([d, [r]]);
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const reset = () => setPage(1);

  return (
    <div>
      <SectionHeader
        title="Activity"
        subtitle="Who did what, and when. Entries can't be edited or deleted."
        actions={<Button variant="ghost" onClick={exportCsv} disabled={!data?.items.length}>⬇ Export CSV</Button>}
      />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="Person">
          <Select value={actorId} onChange={(e) => { setActorId(e.target.value); reset(); }}>
            <option value="">Everyone</option>
            {data?.actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Action">
          <Select value={area} onChange={(e) => { setArea(e.target.value); reset(); }}>
            {AREAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="From"><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} /></Field>
      </div>

      {error ? (
        <Empty>{error}</Empty>
      ) : data === null ? (
        <Empty>Loading…</Empty>
      ) : groups.length === 0 ? (
        <Empty>No activity for these filters.</Empty>
      ) : (
        <div className="space-y-5">
          {groups.map(([day, rows]) => (
            <section key={day}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-ink/55">{day}</h3>
              <Card className="divide-y divide-ink/10">
                {rows.map((r) => (
                  <div key={r.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                    <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-ink/55">{timeLabel(r.createdAt)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <b>{r.actorName}</b>
                        <Badge tone={tone(r.action)}>{actionLabel(r.action)}</Badge>
                      </div>
                      {r.detail && <p className="mt-0.5 break-words text-ink/70">{r.detail}</p>}
                    </div>
                  </div>
                ))}
              </Card>
            </section>
          ))}
          {pages > 1 && (
            <div className="flex items-center justify-center gap-3 text-sm">
              <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</Button>
              <span>Page {page} of {pages}</span>
              <Button variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older →</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
