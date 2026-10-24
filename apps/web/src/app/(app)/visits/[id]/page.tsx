"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Notice, PageHeader, Select, Spinner, StatusBadge, Textarea } from "@/components/ui";
import { AmendModal, VersionHistory, type VersionRow } from "@/components/amend-consultation";
import { blankItem, RxRows, toPayload, type RxItem } from "@/components/rx-editor";
import { api, ApiError, printUrl } from "@/lib/api";
import { ageText, type AgeValue } from "@/lib/format";
import { useMe } from "@/lib/me";

interface Workspace {
  header: { patientId: string; mrn: string | null; name: string; gender: string; age: AgeValue; bloodGroup: string | null; encounterId: string; encounterNumber: string; visitStatus: string; startedAt: string; practitionerName: string | null; departmentName: string | null };
  allergies: { id: string; allergen: string; severity: string; reaction: string | null }[];
  latestVitals: Record<string, { value: string; unit: string; recordedAt: string }>;
  previousVisits: { id: string; encounterNumber: string; startedAt: string; practitionerName: string | null; diagnoses?: { text: string }[]; summary?: string | null }[];
  consultation: Consultation;
}
interface Order { id: string; orderNumber: string | null; status: string; items: RxItem[] }
interface Consultation {
  document: { id: string; status: string; version: number; currentVersion: number; content: Content; signedAt: string | null; signedByName: string | null; versions: VersionRow[] } | null;
  diagnoses: { id: string; text: string; code: string | null; type: string }[];
  prescription: { orders: Order[]; allergyWarnings: Warning[] } | null;
}
interface Content { chiefComplaint?: string; historyOfPresentIllness?: string; examination?: string; advice?: string; followUp?: { afterDays?: number; notes?: string } }
interface Warning { allergyId: string; allergen: string; severity: string; matchedItem: string }

const VITALS: { type: string; label: string; unit: string }[] = [
  { type: "SYSTOLIC_BP", label: "BP systolic", unit: "mmHg" }, { type: "DIASTOLIC_BP", label: "BP diastolic", unit: "mmHg" }, { type: "PULSE", label: "Pulse", unit: "/min" },
  { type: "TEMPERATURE", label: "Temperature", unit: "°C" }, { type: "SPO2", label: "SpO₂", unit: "%" }, { type: "RESPIRATORY_RATE", label: "Resp. rate", unit: "/min" }, { type: "WEIGHT", label: "Weight", unit: "kg" },
];
export default function VisitPage() {
  const { id } = useParams<{ id: string }>();
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ["workspace", id], queryFn: () => api.get<Workspace>(`/encounters/${id}/workspace`) });
  const [note, setNote] = useState<Content>({});
  const [items, setItems] = useState<RxItem[]>([]);
  const [dx, setDx] = useState({ text: "", code: "", type: "PROVISIONAL" });
  const [vit, setVit] = useState<Record<string, string>>({});
  const [amending, setAmending] = useState(false);
  const [ack, setAck] = useState<Warning[] | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  // The note and the prescription are saved separately, so each re-syncs from the server independently: saving one must not wipe unsaved edits to the other.
  const [synced, setSynced] = useState<{ note: string | null; rx: string | null }>({ note: null, rx: null });

  const c = ws.data?.consultation;
  const doc = c?.document;
  const signed = !!doc && doc.status !== "DRAFT";
  const orders = c?.prescription?.orders ?? [];
  const rxOrder = orders.find((o) => o.status === "DRAFT") ?? orders.find((o) => o.status === "SIGNED");

  useEffect(() => {
    if (!ws.data) return;
    if (synced.note !== id) setNote(doc?.content ?? {});
    if (synced.rx !== id) setItems(rxOrder?.items.map((i) => ({ ...i })) ?? []);
    if (synced.note !== id || synced.rx !== id) setSynced({ note: id, rx: id });
  }, [ws.data, id, synced, doc, rxOrder]);

  const reload = () => qc.invalidateQueries({ queryKey: ["workspace", id] });
  const resync = (part: "note" | "rx" | "all") => { setSynced((x) => ({ note: part === "rx" ? x.note : null, rx: part === "note" ? x.rx : null })); void reload(); };

  const saveNote = useMutation({ mutationFn: () => api.put<{ version: number }>(`/encounters/${id}/consultation`, { content: clean(note), ...(doc ? { version: doc.version } : {}) }), onSuccess: () => resync("note") });
  const saveRx = useMutation({ mutationFn: () => api.put(`/encounters/${id}/prescription`, { items: items.filter((i) => i.genericName.trim()).map(toPayload) }), onSuccess: () => resync("rx") });
  const addDx = useMutation({
    mutationFn: () => api.post(`/encounters/${id}/diagnoses`, { text: dx.text, type: dx.type, ...(dx.code ? { code: dx.code } : {}) }),
    onSuccess: () => { setDx({ text: "", code: "", type: "PROVISIONAL" }); void reload(); },
  });
  const rmDx = useMutation({ mutationFn: (dxId: string) => api.post(`/diagnoses/${dxId}/remove`, { reason: "Removed by clinician" }), onSuccess: () => void reload() });
  const addVitals = useMutation({
    mutationFn: () => api.post(`/encounters/${id}/observations`, { observations: Object.entries(vit).filter(([, v]) => v.trim() !== "").map(([type, v]) => ({ type, value: Number(v) })) }),
    onSuccess: () => { setVit({}); void reload(); },
  });
  const sign = useMutation({
    mutationFn: async (acknowledge: boolean) => {
      const saved = await api.put<{ version: number }>(`/encounters/${id}/consultation`, { content: clean(note), ...(doc ? { version: doc.version } : {}) });
      if (items.some((i) => i.genericName.trim())) await api.put(`/encounters/${id}/prescription`, { items: items.filter((i) => i.genericName.trim()).map(toPayload) });
      return api.post(`/encounters/${id}/consultation/sign`, { version: saved.version, ...(acknowledge ? { acknowledgeAllergyWarnings: true } : {}) });
    },
    onSuccess: () => { setAck(null); setAckChecked(false); resync("all"); },
    onError: (e) => { if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setAck(((e.details as { allergyWarnings?: Warning[] } | undefined)?.allergyWarnings) ?? []); },
  });

  if (ws.isLoading) return <Spinner />;
  if (ws.error || !ws.data) return <ErrorNote error={ws.error ?? new Error("Visit not found")} />;
  const h = ws.data.header;
  const canWrite = can("CONSULTATION_CREATE") && !signed && h.visitStatus === "ACTIVE";
  const rxWarnings = c?.prescription?.allergyWarnings ?? [];

  return (
    <Gate anyOf={["CONSULTATION_READ"]}>
      <PageHeader
        title={h.name} subtitle={`MRN ${h.mrn ?? "—"} · ${h.gender.toLowerCase()}${ageText(h.age) ? `, ${ageText(h.age)}` : ""}${h.bloodGroup ? ` · ${h.bloodGroup.replace("_POS", "+").replace("_NEG", "−")}` : ""} · ${h.encounterNumber} · started ${dateTime(h.startedAt)}`}
        actions={<>
          <StatusBadge value={signed ? "SIGNED" : h.visitStatus} />
          {signed && can("CONSULTATION_AMEND") && <Button variant="secondary" onClick={() => setAmending(true)}>Amend…</Button>}
          {signed && <a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`prescriptions/${id}`)} target="_blank" rel="noreferrer">Print prescription</a>}
          {signed && <a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`${printUrl(`prescriptions/${id}`)}?format=pdf&download=1`}>PDF</a>}
        </>}
      />
      {ws.data.allergies.length > 0 && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
          <strong>Allergies:</strong> {ws.data.allergies.map((a) => `${a.allergen} (${a.severity.toLowerCase().replace("_", " ")})`).join(", ")}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <Card title="Vitals">
            <dl className="mb-3 grid grid-cols-2 gap-2 text-sm">
              {VITALS.map((v) => { const l = ws.data.latestVitals[v.type]; return <div key={v.type}><dt className="text-xs text-slate-500">{v.label}</dt><dd className="font-medium">{l ? `${l.value} ${l.unit}` : "—"}</dd></div>; })}
            </dl>
            {can("VITALS_CREATE") && h.visitStatus === "ACTIVE" && (
              <form className="grid grid-cols-2 gap-2" onSubmit={(e) => { e.preventDefault(); addVitals.mutate(); }}>
                {VITALS.map((v) => <Input key={v.type} inputMode="decimal" placeholder={`${v.label} (${v.unit})`} aria-label={v.label} value={vit[v.type] ?? ""} onChange={(e) => setVit({ ...vit, [v.type]: e.target.value })} />)}
                <div className="col-span-2"><Button type="submit" variant="secondary" className="w-full" loading={addVitals.isPending} disabled={!Object.values(vit).some((x) => x.trim())}>Record vitals</Button></div>
                <div className="col-span-2"><ErrorNote error={addVitals.error} /></div>
              </form>
            )}
          </Card>
          <Card title="Previous visits">
            {ws.data.previousVisits.length === 0 ? <p className="text-sm text-slate-500">No earlier completed visits.</p> : (
              <ul className="space-y-2 text-sm">{ws.data.previousVisits.map((v) => <li key={v.id}><div className="font-medium">{dateTime(v.startedAt)}</div><div className="text-slate-500">{v.practitionerName}{v.diagnoses?.length ? ` · ${v.diagnoses.map((d) => d.text).join(", ")}` : ""}</div></li>)}</ul>
            )}
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card title="Consultation" actions={signed ? <Badge tone="green">signed by {doc?.signedByName ?? "doctor"}, {dateTime(doc?.signedAt)}</Badge> : undefined}>
            <div className="grid gap-3">
              <Field label="Complaint"><Textarea disabled={!canWrite} value={note.chiefComplaint ?? ""} onChange={(e) => setNote({ ...note, chiefComplaint: e.target.value })} /></Field>
              <Field label="History"><Textarea disabled={!canWrite} value={note.historyOfPresentIllness ?? ""} onChange={(e) => setNote({ ...note, historyOfPresentIllness: e.target.value })} /></Field>
              <Field label="Examination"><Textarea disabled={!canWrite} value={note.examination ?? ""} onChange={(e) => setNote({ ...note, examination: e.target.value })} /></Field>
              <Field label="Advice"><Textarea disabled={!canWrite} value={note.advice ?? ""} onChange={(e) => setNote({ ...note, advice: e.target.value })} /></Field>
              <Field label="Follow up after (days)" className="max-w-[200px]"><Input disabled={!canWrite} inputMode="numeric" value={note.followUp?.afterDays ?? ""} onChange={(e) => setNote({ ...note, followUp: e.target.value ? { afterDays: Number(e.target.value) } : {} })} /></Field>
            </div>
            {canWrite && <div className="mt-3 flex items-center gap-2"><Button variant="secondary" loading={saveNote.isPending} onClick={() => saveNote.mutate()}>Save draft</Button><ErrorNote error={saveNote.error} /></div>}
          </Card>

          <Card title="Diagnosis">
            <ul className="mb-3 space-y-1">
              {c?.diagnoses.map((d) => (
                <li key={d.id} className="flex items-center justify-between text-sm"><span><span className="font-medium">{d.text}</span> <span className="text-slate-500">{d.code ? `· ${d.code} ` : ""}· {d.type.toLowerCase()}</span></span>
                  {canWrite && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => rmDx.mutate(d.id)}>remove</button>}</li>
              ))}
              {c?.diagnoses.length === 0 && <li className="text-sm text-slate-500">No diagnosis recorded yet.</li>}
            </ul>
            {canWrite && (
              <form className="grid grid-cols-6 gap-2" onSubmit={(e) => { e.preventDefault(); if (dx.text.trim().length >= 2) addDx.mutate(); }}>
                <Input className="col-span-3" placeholder="Diagnosis" aria-label="Diagnosis" value={dx.text} onChange={(e) => setDx({ ...dx, text: e.target.value })} />
                <Input className="col-span-1" placeholder="ICD code" aria-label="Code" value={dx.code} onChange={(e) => setDx({ ...dx, code: e.target.value })} />
                <Select className="col-span-1" aria-label="Type" value={dx.type} onChange={(e) => setDx({ ...dx, type: e.target.value })}><option value="PROVISIONAL">Provisional</option><option value="FINAL">Final</option><option value="SECONDARY">Secondary</option></Select>
                <Button type="submit" variant="secondary" loading={addDx.isPending}>Add</Button>
                <div className="col-span-6"><ErrorNote error={addDx.error ?? rmDx.error} /></div>
              </form>
            )}
          </Card>

          <Card title="Prescription" actions={rxOrder?.orderNumber ? <Badge tone="gray">{rxOrder.orderNumber}</Badge> : undefined}>
            {rxWarnings.length > 0 && !signed && <div className="mb-3"><Notice tone="warn">Allergy alert: {rxWarnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</Notice></div>}
            <RxRows items={items} setItems={setItems} disabled={!canWrite} />
            {canWrite && <div className="mt-3 flex items-center gap-2"><Button variant="secondary" onClick={() => setItems([...items, blankItem()])}>Add medicine</Button><Button variant="secondary" loading={saveRx.isPending} disabled={items.length === 0} onClick={() => saveRx.mutate()}>Save prescription</Button><ErrorNote error={saveRx.error} /></div>}
          </Card>

          {canWrite && can("CONSULTATION_SIGN") && (
            <Card title="Sign">
              {ack ? (
                <div className="space-y-3">
                  <Notice tone="warn">{ack.map((w) => `${w.matchedItem} matches the recorded allergy to ${w.allergen} (${w.severity.toLowerCase().replace("_", " ")})`).join("; ")}</Notice>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} /> I have reviewed the allergy warning and still want to sign.</label>
                  <div className="flex gap-2"><Button disabled={!ackChecked} loading={sign.isPending} onClick={() => sign.mutate(true)}>Sign with acknowledged warning</Button><Button variant="ghost" onClick={() => setAck(null)}>Go back and change</Button></div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <ConfirmButton variant="primary" label="Sign consultation" confirmLabel="Yes, sign — this cannot be edited afterwards" loading={sign.isPending} onConfirm={() => sign.mutate(false)} />
                  <span className="text-xs text-slate-500">Saves the note and prescription, then signs both. Corrections after signing are made as amendments.</span>
                </div>
              )}
              {!ack && <div className="mt-2"><ErrorNote error={sign.error instanceof ApiError && sign.error.code === "ALLERGY_CONFLICT" ? null : sign.error} /></div>}
            </Card>
          )}
          {signed && <Notice tone="success">This consultation is signed. Corrections are recorded as amendments and the original stays on file.</Notice>}
          {signed && doc && <VersionHistory encounterId={id} versions={doc.versions ?? []} />}
        </div>
      </div>
      {amending && doc && <AmendModal encounterId={id} currentVersion={doc.currentVersion} content={doc.content} diagnoses={c?.diagnoses ?? []} rxItems={(orders.find((o) => o.status === "SIGNED")?.items ?? []).filter((i) => i.status !== "STOPPED")} onClose={() => setAmending(false)} onDone={() => { setAmending(false); resync("all"); }} />}
    </Gate>
  );
}

function clean(c: Content): Content {
  const out: Content = {};
  for (const k of ["chiefComplaint", "historyOfPresentIllness", "examination", "advice"] as const) { const v = c[k]?.trim(); if (v) out[k] = v; }
  if (c.followUp?.afterDays) out.followUp = { afterDays: c.followUp.afterDays };
  return out;
}
