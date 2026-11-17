"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { STAFF_ROLES, roleLabel, type StaffRole } from "@/lib/permissions";
import type { StaffDTO } from "@/lib/staff-service";
import Avatar from "@/components/Avatar";
import { api } from "../staff/api";
import { Badge, Button, Card, Empty, Field, Input, Modal, SectionHeader } from "../ui";
import type { SectionProps } from "./types";

type Editing = { mode: "new" } | { mode: "edit"; staff: StaffDTO };

export default function StaffSection({ ws, notify, version }: SectionProps) {
  const [staff, setStaff] = useState<StaffDTO[] | null>(null);
  const [plan, setPlan] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ staff: StaffDTO[]; plan: string }>("GET", "/api/staff");
      setStaff(d.staff);
      setPlan(d.plan);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, version]);

  const godownName = (id: string) => ws.godowns.find((g) => g.id === id)?.name ?? "(removed)";
  const isFree = plan === "FREE";

  async function toggleActive(s: StaffDTO) {
    try {
      await api("PATCH", `/api/staff/${s.id}`, { active: !s.active });
      notify(s.active ? `${s.name} can no longer log in` : `${s.name} reactivated`);
      load();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  async function remove(s: StaffDTO) {
    if (!confirm(`Remove ${s.name}? Their past entries stay in the ledger and activity log.`)) return;
    try {
      await api("DELETE", `/api/staff/${s.id}`);
      notify("Staff member removed");
      load();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Staff & roles"
        subtitle="Give your team their own login. Each role only sees what it needs."
        actions={<Button onClick={() => setEditing({ mode: "new" })} disabled={isFree}>+ Add staff</Button>}
      />

      {isFree && (
        <div className="mb-4 rounded-xl border-2 border-low bg-low/10 p-4 text-sm">
          <b>Staff logins are a Pro feature.</b> Your free trial has ended.{" "}
          <Link href="/upgrade" className="font-bold underline">Get Lifetime Pro</Link> to add or reactivate staff. Existing staff are kept but can&apos;t be reactivated.
        </div>
      )}

      <div className="mb-5 grid gap-3 md:grid-cols-3">
        {STAFF_ROLES.map((r) => (
          <Card key={r.role} className="p-4">
            <div className="font-bold">{r.label}</div>
            <p className="mt-1 text-xs text-ink/65">{r.summary}</p>
          </Card>
        ))}
      </div>

      {error ? (
        <Empty>{error}</Empty>
      ) : staff === null ? (
        <Empty>Loading…</Empty>
      ) : staff.length === 0 ? (
        <Empty>No staff yet. Add a staff member to give them their own login.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {staff.map((s) => (
            <Card key={s.id} className={`p-4 ${s.active ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={s.name} src={s.avatar} size={40} />
                  <div className="min-w-0">
                    <div className="truncate font-bold">{s.name}</div>
                    <div className="truncate text-xs text-ink/60">{s.email}</div>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge tone="ink">{roleLabel(s.role)}</Badge>
                  {!s.active && <Badge tone="out">Inactive</Badge>}
                </div>
              </div>
              <p className="mt-2 text-xs text-ink/70">
                Godowns: {s.godownIds.length === 0 ? <b>All</b> : s.godownIds.map(godownName).join(", ")}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => setEditing({ mode: "edit", staff: s })}>Edit</Button>
                <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => toggleActive(s)} disabled={!s.active && isFree}>
                  {s.active ? "Deactivate" : "Reactivate"}
                </Button>
                <Button variant="danger" className="px-2.5 py-1.5 text-xs" onClick={() => remove(s)}>Remove</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <StaffModal
          editing={editing}
          godowns={ws.godowns}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            notify(msg);
            load();
          }}
        />
      )}
    </div>
  );
}

function StaffModal({
  editing,
  godowns,
  onClose,
  onSaved,
}: {
  editing: Editing;
  godowns: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const existing = editing.mode === "edit" ? editing.staff : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<StaffRole>(existing?.role ?? "SALES");
  const [ids, setIds] = useState<string[]>(existing?.godownIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api("PATCH", `/api/staff/${existing.id}`, { name, role, godownIds: ids, ...(password ? { password } : {}) });
        onSaved(password ? "Staff updated and password reset" : "Staff updated");
      } else {
        await api("POST", "/api/staff", { name, email, password, role, godownIds: ids });
        onSaved(`${name} can now log in with ${email}`);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.name}` : "Add staff"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Login email" hint={existing ? "Email can't be changed. Remove and re-add to change it." : undefined}>
          <Input required type="email" value={email} disabled={!!existing} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <Field label={existing ? "New password (leave blank to keep)" : "Temporary password"} hint="At least 8 characters. Share it with them privately.">
          <Input type="password" required={!existing} minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <fieldset>
          <legend className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink/70">Role</legend>
          <div className="space-y-2">
            {STAFF_ROLES.map((r) => (
              <label key={r.role} className={`flex cursor-pointer gap-2 rounded-lg border-2 p-2.5 text-sm ${role === r.role ? "border-ink" : "border-ink/15"}`}>
                <input type="radio" name="role" checked={role === r.role} onChange={() => setRole(r.role)} className="mt-1" />
                <span>
                  <b>{r.label}</b>
                  <span className="block text-xs text-ink/65">{r.summary}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink/70">Godown access</legend>
          <p className="mb-2 text-xs text-ink/60">{ids.length === 0 ? "All godowns (none selected)." : `${ids.length} selected.`}</p>
          <div className="flex flex-wrap gap-2">
            {godowns.map((g) => (
              <label key={g.id} className={`cursor-pointer rounded-lg border-2 px-2.5 py-1.5 text-sm ${ids.includes(g.id) ? "border-ink bg-ink text-paper" : "border-ink/20"}`}>
                <input type="checkbox" className="sr-only" checked={ids.includes(g.id)} onChange={() => toggle(g.id)} />
                {g.name}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p role="alert" className="rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? "Saving…" : existing ? "Save changes" : "Add staff"}</Button>
      </form>
    </Modal>
  );
}
