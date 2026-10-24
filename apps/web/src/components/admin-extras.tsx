"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Modal, Notice, Select, Spinner } from "./ui";

// ───────────────────────── doctor schedules ─────────────────────────

interface Win { dayOfWeek: number; start: string; end: string; slotMinutes: number }
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Weekly sessions for a doctor. Appointments can only be booked inside these sessions; slot length sets the booking step. */
export function ScheduleEditor({ doctors }: { doctors: { id: string; displayName: string }[] }) {
  const qc = useQueryClient();
  const [doc, setDoc] = useState("");
  const [wins, setWins] = useState<Win[] | null>(null);
  const load = useQuery({ queryKey: ["schedule", doc], queryFn: async () => { const w = await api.get<Win[]>(`/practitioners/${doc}/schedule`); setWins(w); return w; }, enabled: !!doc });
  const save = useMutation({ mutationFn: () => api.put(`/practitioners/${doc}/schedule`, { windows: wins }), onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule", doc] }) });
  const patch = (i: number, p: Partial<Win>) => setWins((wins ?? []).map((w, j) => (j === i ? { ...w, ...p } : w)));
  const weekdays = (d: number) => (wins ?? []).map((w, i) => ({ w, i })).filter((x) => x.w.dayOfWeek === d);
  const preset = () => setWins([1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: "09:00", end: "13:00", slotMinutes: 15 })));
  return (
    <Card title="Weekly schedule">
      <div className="space-y-3">
        <Field label="Doctor"><Select value={doc} onChange={(e) => { setDoc(e.target.value); setWins(null); }}><option value="">Choose…</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
        {doc && load.isLoading && <Spinner />}
        {doc && wins && (
          <div className="space-y-2">
            {DAYS.map((name, d) => (
              <div key={name} className="grid grid-cols-12 items-start gap-2 border-b border-slate-100 pb-2">
                <div className="col-span-12 pt-1.5 text-sm font-medium sm:col-span-2">{name}</div>
                <div className="col-span-12 space-y-1 sm:col-span-10">
                  {weekdays(d).length === 0 && <span className="text-sm text-slate-400">No session</span>}
                  {weekdays(d).map(({ w, i }) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Input aria-label={`${name} start`} type="time" className="w-28" value={w.start} onChange={(e) => patch(i, { start: e.target.value })} />
                      <span className="text-slate-400">to</span>
                      <Input aria-label={`${name} end`} type="time" className="w-28" value={w.end} onChange={(e) => patch(i, { end: e.target.value })} />
                      <Select aria-label={`${name} slot length`} className="w-32" value={String(w.slotMinutes)} onChange={(e) => patch(i, { slotMinutes: Number(e.target.value) })}>{[5, 10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min slots</option>)}</Select>
                      <button className="text-slate-400 hover:text-red-700" aria-label={`Remove ${name} session`} onClick={() => setWins(wins.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                  <button className="text-xs text-brand-700 hover:underline" onClick={() => setWins([...wins, { dayOfWeek: d, start: "09:00", end: "13:00", slotMinutes: 15 }])}>+ add session</button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button loading={save.isPending} onClick={() => save.mutate()}>Save schedule</Button>
              <Button variant="ghost" onClick={preset}>Mon–Sat mornings</Button>
              {save.isSuccess && <span className="text-sm text-green-700">Saved</span>}
            </div>
            <ErrorNote error={save.error} />
          </div>
        )}
      </div>
    </Card>
  );
}

// ───────────────────────── roles ─────────────────────────

interface Role { id: string; name: string; isSystem: boolean; permissions: string[] }
const GROUP = (p: string) => p.split("_")[0] ?? p;
const nice = (p: string) => p.toLowerCase().replace(/_/g, " ");

function PermissionGrid({ all, value, onChange, disabled }: { all: string[]; value: Set<string>; onChange: (s: Set<string>) => void; disabled?: boolean }) {
  const groups = [...new Set(all.map(GROUP))];
  const toggle = (p: string) => { const n = new Set(value); if (n.has(p)) n.delete(p); else n.add(p); onChange(n); };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {groups.map((g) => (
        <fieldset key={g} className="rounded-md border border-slate-200 p-2">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.toLowerCase()}</legend>
          {all.filter((p) => GROUP(p) === g).map((p) => (
            <label key={p} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" disabled={disabled} checked={value.has(p)} onChange={() => toggle(p)} /> {nice(p)}</label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function RoleEditor({ role, all, onClose }: { role: Role | null; all: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(role?.name ?? "");
  const [perms, setPerms] = useState(new Set(role?.permissions ?? []));
  const readOnly = role?.isSystem ?? false;
  const save = useMutation({
    mutationFn: () => (role ? api.put(`/roles/${role.id}/permissions`, { permissions: [...perms] }) : api.post("/roles", { name: name.trim(), permissions: [...perms] })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["roles"] }); onClose(); },
  });
  return (
    <Modal title={role ? (readOnly ? `${role.name.toLowerCase()} (built-in role)` : `Edit role — ${role.name}`) : "New role"} onClose={onClose} wide>
      <div className="space-y-3">
        {!role && <Field label="Role name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        {readOnly && <Notice>Built-in roles cannot be changed. Create a custom role to give different access.</Notice>}
        <PermissionGrid all={all} value={perms} onChange={setPerms} disabled={readOnly} />
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Close</Button>{!readOnly && <ConfirmButton variant="primary" label="Save role" confirmLabel="Yes, change access" disabled={perms.size === 0 || (!role && name.trim().length < 2)} loading={save.isPending} onConfirm={() => save.mutate()} />}</div>
      </div>
    </Modal>
  );
}

export function RolesCard() {
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles") });
  const perms = useQuery({ queryKey: ["permissions"], queryFn: () => api.get<string[]>("/permissions") });
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  return (
    <Card title="Roles and access" actions={<Button variant="secondary" onClick={() => setEditing("new")}>New role</Button>}>
      {roles.isLoading ? <Spinner /> : (
        <ul className="divide-y divide-slate-100">
          {roles.data?.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2 text-sm">
              <span><span className="font-medium">{r.name.toLowerCase()}</span> {r.isSystem && <Badge tone="gray">built-in</Badge>} <span className="text-slate-500">· {r.permissions.length} permissions</span></span>
              <Button variant="ghost" onClick={() => setEditing(r)}>{r.isSystem ? "View" : "Edit"}</Button>
            </li>
          ))}
        </ul>
      )}
      {editing && perms.data && <RoleEditor role={editing === "new" ? null : editing} all={perms.data} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ───────────────────────── staff: roles and password reset ─────────────────────────

export function StaffAccess({ user, onClose }: { user: { id: string; fullName: string; username: string; roles: { id: string; name: string }[] }; onClose: () => void }) {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles") });
  const [picked, setPicked] = useState(new Set(user.roles.map((r) => r.id)));
  const [pw, setPw] = useState("");
  const setRoles = useMutation({ mutationFn: () => api.put(`/users/${user.id}/roles`, { roleIds: [...picked] }), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["users"] }); onClose(); } });
  const reset = useMutation({ mutationFn: () => api.post(`/users/${user.id}/reset-password`, { password: pw }), onSuccess: () => setPw("") });
  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  return (
    <Modal title={`${user.fullName} (${user.username})`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <div className="mb-1 text-sm font-medium text-slate-700">Roles</div>
          {roles.isLoading ? <Spinner /> : roles.data?.map((r) => <label key={r.id} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /> {r.name.toLowerCase()}</label>)}
          <ErrorNote error={setRoles.error} />
          <div className="mt-2"><ConfirmButton variant="primary" label="Save roles" confirmLabel="Yes, change access" disabled={picked.size === 0} loading={setRoles.isPending} onConfirm={() => setRoles.mutate()} /></div>
        </div>
        <div className="border-t border-slate-100 pt-3">
          <Field label="Set a new password" hint="At least 10 characters with letters and digits. The person is signed out everywhere."><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          {reset.isSuccess && <p className="mt-1 text-sm text-green-700">Password changed.</p>}
          <ErrorNote error={reset.error} />
          <div className="mt-2"><ConfirmButton variant="primary" label="Reset password" confirmLabel="Yes, reset" disabled={pw.length < 10} loading={reset.isPending} onConfirm={() => reset.mutate()} /></div>
        </div>
      </div>
    </Modal>
  );
}
