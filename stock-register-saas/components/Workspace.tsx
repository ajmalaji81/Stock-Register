"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { StoreError, type StockStore } from "@/lib/store";
import type { Godown, Item, ItemInput, MovementInput, Scope, TransferInput, Workspace as WorkspaceData } from "@/lib/types";
import { ItemModal, StockModal, TransferModal } from "./modals";
import { IconTile, Modal, Select } from "./ui";
import { trialDaysLeft } from "@/lib/plans";
import { Dashboard, GodownsView, ItemsView, LedgerView, ReportsView } from "./views";
import type { Permission } from "@/lib/permissions";
import { NAV, NAV_GROUPS, type NavEntry } from "./sections/registry";

type Tab = NavEntry["key"];

type ModalState =
  | { kind: "item"; item: Item | null }
  | { kind: "stock"; type: "IN" | "OUT"; itemId?: string }
  | { kind: "transfer" };

const scopeKey = (mode: string) => `godownbook-scope-${mode}`;

/** Entries shown in the phone bottom bar (when permitted); everything else lives under "More". */
const TABBAR_PREFERRED: Tab[] = ["dashboard", "items", "sales", "ledger"];

export default function Workspace({ store, onReset }: { store: StockStore; onReset?: () => void }) {
  const [ws, setWs] = useState<WorkspaceData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [scope, setScopeState] = useState<Scope>("ALL");
  const [ledgerItem, setLedgerItem] = useState("");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; bad?: boolean; limit?: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await store.load();
      setWs(data);
      setVersion((v) => v + 1);
      setLoadError(null);
      setScopeState((s) => {
        let saved = s;
        try {
          saved = localStorage.getItem(scopeKey(data.mode)) ?? s;
        } catch {
          /* storage unavailable */
        }
        return saved === "ALL" || data.godowns.some((g) => g.id === saved) ? saved : "ALL";
      });
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [store]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.limit ? 8000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const setScope = (s: Scope) => {
    setScopeState(s);
    try {
      if (ws) localStorage.setItem(scopeKey(ws.mode), s);
    } catch {
      /* ignore */
    }
  };

  const closeModal = useCallback(() => {
    setModal(null);
    setError(null);
  }, []);

  const closeMore = useCallback(() => setMoreOpen(false), []);

  /** Run a modal action; keep the modal open with the error if it fails. */
  const submit = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      setModal(null);
      setToast({ text: done });
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof StoreError && e.code === "LIMIT") setToast({ text: (e as Error).message, bad: true, limit: true });
    } finally {
      setBusy(false);
    }
  };

  /** Run a non-modal action; report via toast. */
  const act = async (fn: () => Promise<void>, done: string): Promise<boolean> => {
    try {
      await fn();
      await refresh();
      setToast({ text: done });
      return true;
    } catch (e) {
      setToast({ text: (e as Error).message, bad: true, limit: e instanceof StoreError && e.code === "LIMIT" });
      return false;
    }
  };

  if (loadError)
    return (
      <div className="p-4">
        <div className="card-3d border-out/40 p-6 text-out">Couldn&apos;t load your register: {loadError}</div>
      </div>
    );
  if (!ws)
    return (
      <div className="grid gap-3 p-4 sm:grid-cols-4" aria-busy="true" aria-label="Loading register">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="well h-24 animate-pulse rounded-2xl motion-reduce:animate-none" />
        ))}
      </div>
    );

  const { items, godowns, limits, mode, user } = ws;
  const scopeName = scope === "ALL" ? "All Locations" : godowns.find((g) => g.id === scope)?.name ?? "";
  const viewProps = { store, items, godowns, scope, version, scopeName };
  const perms = new Set(ws.actor.permissions);
  const can = (p: Permission) => perms.has(p);
  const nav = NAV.filter((n) => n.anyOf.length === 0 || n.anyOf.some(can));
  const current = nav.find((n) => n.key === tab) ?? nav[0];
  const sectionProps = {
    ws, scope, scopeName, version, refresh, can,
    notify: (text: string, bad?: boolean) => setToast({ text, bad }),
  };
  const tabbar = TABBAR_PREFERRED.map((k) => nav.find((n) => n.key === k)).filter((n): n is NavEntry => !!n).slice(0, 4);
  const currentInBar = tabbar.some((n) => n.key === current.key);

  const go = (k: Tab) => {
    setTab(k);
    setMoreOpen(false);
  };

  const openStock = (type: "IN" | "OUT", itemId?: string) => setModal({ kind: "stock", type, itemId });

  const upgradeCta =
    mode === "demo" ? (
      <Link href="/signup" className="font-bold underline">Create a free account</Link>
    ) : (
      <Link href="/upgrade" className="font-bold underline">Upgrade to Lifetime Pro</Link>
    );

  const badgeBase = "inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-xs font-bold ring-1 ring-inset shadow-[inset_0_1px_0_rgb(255_255_255/0.6)]";
  const planBadge =
    mode === "demo" ? (
      <span className="flex items-center gap-2">
        <span className={`${badgeBase} bg-low/15 text-low ring-low/30`}>DEMO · {items.length}/{limits.maxItems} items</span>
        {onReset && (
          <button
            className="rounded-md px-1 text-xs font-semibold underline focus-visible:outline-3 focus-visible:outline-brand"
            onClick={async () => { onReset(); await refresh(); setToast({ text: "Demo reset" }); }}
          >
            Reset
          </button>
        )}
      </span>
    ) : user?.plan === "PRO" ? (
      <span className={`${badgeBase} bg-brand-soft text-in ring-in/25`}>★ LIFETIME PRO</span>
    ) : user?.plan === "TRIAL" ? (
      <Link href="/upgrade" className={`${badgeBase} bg-brand-soft text-in ring-in/25 hover:bg-brand/20`}>
        PRO TRIAL · {trialDaysLeft(user.trialEndsAt)}d left<span className="hidden @2xl:inline"> — Get Lifetime</span>
      </Link>
    ) : (
      <Link href="/upgrade" className={`${badgeBase} bg-ink text-paper ring-ink`}>
        FREE · {items.length}/{limits.maxItems}<span className="hidden @2xl:inline"> items — Upgrade</span>
      </Link>
    );

  const navList = (onPick: (k: Tab) => void) =>
    NAV_GROUPS.map((g) => {
      const entries = nav.filter((n) => n.group === g);
      if (entries.length === 0) return null;
      return (
        <div key={g}>
          <div className="mb-1 px-2 text-[11px] font-bold uppercase tracking-wider text-ink/45">{g}</div>
          <ul className="space-y-0.5">
            {entries.map((n) => {
              const active = current.key === n.key;
              return (
                <li key={n.key}>
                  <button className="nav-item" aria-current={active ? "page" : undefined} onClick={() => onPick(n.key)}>
                    <IconTile size="sm" tone={active ? "brand" : "ink"}>{n.icon}</IconTile>
                    <span className="truncate">{n.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      );
    });

  return (
    <div className="@container flex min-h-full flex-col bg-surface">
      <div className="flex flex-1 flex-col @4xl:grid @4xl:grid-cols-[14.5rem_minmax(0,1fr)]">
        {/* Sidebar — only when the container is wide (works in the full app and inside the landing demo frame). */}
        <aside className="hidden border-r border-ink/10 bg-gradient-to-b from-paper/60 to-transparent @4xl:block print:hidden" aria-label="Sections">
          <nav className="sticky top-16 flex max-h-[calc(100vh-4.5rem)] flex-col gap-4 overflow-y-auto p-3">{navList(go)}</nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar: current section, location switcher, plan */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink/10 bg-paper/70 px-3 py-2.5 backdrop-blur @4xl:px-5 print:hidden">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <IconTile size="sm" tone="brand">{current.icon}</IconTile>
              <h2 className="truncate text-base font-bold tracking-tight @lg:text-lg">{current.label}</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Location"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="w-auto max-w-[11rem] py-1.5 font-semibold @lg:max-w-[16rem]"
              >
                <option value="ALL">📍 All Locations</option>
                {godowns.map((g) => <option key={g.id} value={g.id}>📍 {g.name}</option>)}
              </Select>
              {planBadge}
            </div>
          </div>

          <main className="flex-1 p-3 pb-6 @lg:p-4 @4xl:p-5">
            {current.component &&
              (mode === "demo" && current.liveOnly ? (
                <div className="card-3d pop-in mx-auto max-w-md p-8 text-center">
                  <div className="flex justify-center"><IconTile size="lg" tone="brand">{current.icon}</IconTile></div>
                  <h3 className="mt-3 text-lg font-bold">{current.label} is in the full app</h3>
                  <p className="mt-1 text-sm text-ink/70">The demo covers stock, godowns, ledger and reports. Create a free account for billing, parties, staff and more — every Pro feature free for 90 days.</p>
                  <Link href="/signup" className="btn-3d btn-edge-ink mt-5 inline-block rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-paper">Start free trial</Link>
                </div>
              ) : (
                <current.component {...sectionProps} />
              ))}
            {current.key === "dashboard" && (
              <Dashboard
                {...viewProps}
                showValue={can("costs.view")}
                onStock={can("stock.move") ? openStock : undefined}
                onTransfer={can("stock.transfer") ? () => setModal({ kind: "transfer" }) : undefined}
                onGoLedger={() => { setLedgerItem(""); setTab("ledger"); }}
              />
            )}
            {current.key === "items" && (
              <ItemsView
                items={items}
                godowns={godowns}
                scope={scope}
                showCosts={can("costs.view")}
                onNew={can("items.manage") ? () => setModal({ kind: "item", item: null }) : undefined}
                onEdit={can("items.manage") ? (item) => setModal({ kind: "item", item }) : undefined}
                onStock={can("stock.move") ? openStock : undefined}
                onLedger={(id) => { setLedgerItem(id); setTab("ledger"); }}
                onDelete={
                  can("items.manage")
                    ? (i) => {
                        if (confirm(`Delete "${i.name}"? This also deletes its ledger history and can't be undone.`))
                          act(() => store.deleteItem(i.id), "Item deleted");
                      }
                    : undefined
                }
              />
            )}
            {current.key === "ledger" && <LedgerView {...viewProps} itemId={ledgerItem} setItemId={setLedgerItem} />}
            {current.key === "reports" && <ReportsView {...viewProps} />}
            {current.key === "godowns" && (
              <GodownsView
                items={items}
                godowns={godowns}
                limitText={limits.maxGodowns !== null ? `${mode === "demo" ? "Demo" : "Free plan"}: up to ${limits.maxGodowns} godowns.` : null}
                onAdd={(name) => act(() => store.addGodown(name), "Godown added")}
                onRename={(g: Godown) => {
                  const name = prompt("New name for this godown", g.name);
                  if (name && name.trim() && name.trim() !== g.name) act(() => store.renameGodown(g.id, name.trim()), "Godown renamed");
                }}
                onDelete={(g: Godown) => {
                  if (confirm(`Delete godown "${g.name}"?`)) act(() => store.deleteGodown(g.id), "Godown deleted");
                }}
              />
            )}
          </main>

          {/* Phone / narrow container: bottom tab bar */}
          <nav className="tabbar sticky bottom-0 z-30 grid gap-1 px-2 pb-[max(0.4rem,env(safe-area-inset-bottom))] pt-1.5 @4xl:hidden print:hidden" style={{ gridTemplateColumns: `repeat(${tabbar.length + 1}, minmax(0, 1fr))` }} aria-label="Main">
            {tabbar.map((n) => (
              <button key={n.key} className="tabbar-item" aria-current={current.key === n.key && !moreOpen ? "page" : undefined} onClick={() => go(n.key)}>
                <span aria-hidden className="tabbar-icon">{n.icon}</span>
                <span className="max-w-full truncate">{n.label}</span>
              </button>
            ))}
            <button
              className="tabbar-item"
              aria-current={moreOpen || !currentInBar ? "page" : undefined}
              aria-haspopup="dialog"
              onClick={() => setMoreOpen(true)}
            >
              <span aria-hidden className="tabbar-icon">☰</span>
              <span>More</span>
            </button>
          </nav>
        </div>
      </div>

      {moreOpen && (
        <Modal title="All sections" onClose={closeMore}>
          <nav className="grid gap-4 @md:grid-cols-2" aria-label="All sections">{navList(go)}</nav>
        </Modal>
      )}

      {modal?.kind === "item" && (
        <ItemModal
          item={modal.item}
          godowns={godowns}
          scope={scope}
          busy={busy}
          error={error}
          onClose={closeModal}
          onSave={(input: ItemInput) => submit(() => store.saveItem(input, modal.item?.id ?? null), modal.item ? "Item updated" : "Item added")}
        />
      )}
      {modal?.kind === "stock" && (
        <StockModal
          type={modal.type}
          items={items}
          godowns={godowns}
          scope={scope}
          initialItemId={modal.itemId}
          busy={busy}
          error={error}
          onClose={closeModal}
          onSave={(input: MovementInput) => submit(() => store.recordMovement(input), modal.type === "IN" ? "Stock added" : "Stock removed")}
        />
      )}
      {modal?.kind === "transfer" && (
        <TransferModal
          items={items}
          godowns={godowns}
          scope={scope}
          busy={busy}
          error={error}
          onClose={closeModal}
          onSave={(input: TransferInput) => submit(() => store.transfer(input), "Stock transferred")}
        />
      )}

      {toast && (
        <div
          role="status"
          style={{ "--toast-edge": toast.bad ? "var(--color-out)" : "var(--color-in)" } as CSSProperties}
          className={`toast-3d pop-in fixed bottom-24 left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-start gap-3 px-4 py-3 text-sm font-semibold sm:bottom-6 print:hidden ${toast.bad ? "text-out" : "text-in"}`}
        >
          <IconTile size="sm" tone={toast.bad ? "out" : "in"}>{toast.bad ? "!" : "✓"}</IconTile>
          <span className="pt-1">
            {toast.text} {toast.limit && <span className="text-ink">— {upgradeCta}</span>}
          </span>
        </div>
      )}
    </div>
  );
}
