"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { EditPatientModal, FilesCard, PatientPhoto, type EditablePatient } from "@/components/patient-extras";
import { Button, Card, ErrorNote, Field, Input, KV, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td } from "@/components/ui";
import { api, newKey, printUrl } from "@/lib/api";
import { ageText, type AgeValue } from "@/lib/format";
import { useMe } from "@/lib/me";

interface Patient {
  id: string; mrn: string | null; firstName: string; lastName: string | null; gender: string; dateOfBirth: string | null; age: AgeValue; mobile: string | null;
  addressLine: string | null; city: string | null; district: string | null; state: string | null; postalCode: string | null; bloodGroup: string | null; version: number; status: string;
  guardianName: string | null; guardianRelation: string | null; guardianMobile: string | null; emergencyContactName: string | null; emergencyContactMobile: string | null;
}
interface Allergy { id: string; allergen: string; type: string; severity: string; reaction: string | null; status: string }
interface Encounter { id: string; encounterNumber: string; type: string; status: string; startedAt: string; practitionerName?: string | null; departmentName?: string | null }
interface InvoiceRow { id: string; invoiceNumber: string | null; status: string; total: string; balanceDue: string; createdAt: string; kind: string }
interface Practitioner { id: string; displayName: string; specialty?: string | null }

function StartVisit({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const router = useRouter();
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Practitioner[]>("/practitioners") });
  const [doc, setDoc] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<{ encounter: { id: string } }>("/appointments/walk-in", { patientId, practitionerId: doc }, newKey()),
    onSuccess: () => router.push("/queue"),
  });
  return (
    <Modal title="Start an OPD visit" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Doctor"><Select value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">Choose a doctor…</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}{d.specialty ? ` — ${d.specialty}` : ""}</option>)}</Select></Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!doc} loading={m.isPending} onClick={() => m.mutate()}>Check in and add to queue</Button></div>
      </div>
    </Modal>
  );
}

function Allergies({ patientId }: { patientId: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["allergies", patientId], queryFn: () => api.get<Allergy[]>(`/patients/${patientId}/allergies`) });
  const [form, setForm] = useState({ allergen: "", type: "DRUG", severity: "MODERATE", reaction: "" });
  const add = useMutation({
    mutationFn: () => api.post(`/patients/${patientId}/allergies`, { allergen: form.allergen, type: form.type, severity: form.severity, ...(form.reaction ? { reaction: form.reaction } : {}) }),
    onSuccess: () => { setForm({ allergen: "", type: "DRUG", severity: "MODERATE", reaction: "" }); void qc.invalidateQueries({ queryKey: ["allergies", patientId] }); },
  });
  return (
    <Card title="Allergies">
      {list.isLoading ? <Spinner /> : list.data?.length === 0 ? <p className="text-sm text-slate-500">No known allergies recorded.</p> : (
        <ul className="mb-3 space-y-1">{list.data?.map((a) => <li key={a.id} className="text-sm"><span className="font-medium text-red-700">{a.allergen}</span> <span className="text-slate-500">· {a.type.toLowerCase()} · {a.severity.toLowerCase().replace("_", " ")}{a.reaction ? ` · ${a.reaction}` : ""}</span></li>)}</ul>
      )}
      {can("ALLERGY_WRITE") && (
        <form className="grid grid-cols-2 gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); if (form.allergen.trim().length >= 2) add.mutate(); }}>
          <Input className="col-span-2" placeholder="Allergen (e.g. Penicillin)" aria-label="Allergen" value={form.allergen} onChange={(e) => setForm({ ...form, allergen: e.target.value })} />
          <Select aria-label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="DRUG">Drug</option><option value="FOOD">Food</option><option value="ENVIRONMENT">Environment</option><option value="OTHER">Other</option></Select>
          <Select aria-label="Severity" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}><option value="MILD">Mild</option><option value="MODERATE">Moderate</option><option value="SEVERE">Severe</option><option value="LIFE_THREATENING">Life threatening</option></Select>
          <Button type="submit" loading={add.isPending}>Add</Button>
          <div className="col-span-2 sm:col-span-5"><ErrorNote error={add.error} /></div>
        </form>
      )}
    </Card>
  );
}

export default function PatientPage() {
  const { id } = useParams<{ id: string }>();
  const { can, features, date, dateTime, money } = useMe();
  const [visit, setVisit] = useState(false);
  const [editing, setEditing] = useState(false);
  const p = useQuery({ queryKey: ["patient", id], queryFn: () => api.get<Patient>(`/patients/${id}`) });
  const enc = useQuery({ queryKey: ["patient-enc", id], queryFn: () => api.page<Encounter>(`/patients/${id}/encounters`, { pageSize: 10 }), enabled: can("CONSULTATION_READ", "QUEUE_READ", "PATIENT_READ") });
  const inv = useQuery({ queryKey: ["patient-inv", id], queryFn: () => api.page<InvoiceRow>("/invoices", { patientId: id, pageSize: 10 }), enabled: can("INVOICE_READ") });
  if (p.isLoading) return <Spinner />;
  if (p.error || !p.data) return <ErrorNote error={p.error ?? new Error("Patient not found")} />;
  const pt = p.data;
  const name = [pt.firstName, pt.lastName].filter(Boolean).join(" ");
  return (
    <Gate anyOf={["PATIENT_READ"]}>
      <PageHeader
        title={name} icon={<PatientPhoto patientId={pt.id} />} subtitle={`MRN ${pt.mrn ?? "—"} · ${pt.gender.toLowerCase()}${ageText(pt.age) ? `, ${ageText(pt.age)}` : ""}`}
        actions={<>
          {can("APPOINTMENT_CREATE") && <Button onClick={() => setVisit(true)}>Start OPD visit</Button>}
          {can("INVOICE_CREATE") && <Link href={`/billing?patient=${pt.id}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">New bill</Link>}
          {can("ADMISSION_CREATE") && features.IPD_ENABLED && <Link href={`/ipd?admit=${pt.id}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Admit</Link>}
          {can("PATIENT_UPDATE") && <Button variant="secondary" onClick={() => setEditing(true)}>Edit details</Button>}
          <a href={printUrl(`patient-labels/${pt.id}`)} target="_blank" rel="noreferrer" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Print label</a>
          <a href={`${printUrl(`patient-labels/${pt.id}`)}?format=pdf&download=1`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Label PDF</a>
        </>}
      />
      {pt.status !== "ACTIVE" && <Notice tone="warn">This patient record is inactive.</Notice>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-1">
          <dl className="grid grid-cols-2 gap-3">
            <KV label="Mobile">{pt.mobile}</KV><KV label="Date of birth">{pt.dateOfBirth ? date(pt.dateOfBirth) : null}</KV>
            <KV label="Blood group">{pt.bloodGroup?.replace("_POS", "+").replace("_NEG", "−")}</KV><KV label="City">{pt.city}</KV>
            <div className="col-span-2"><KV label="Address">{[pt.addressLine, pt.district, pt.state, pt.postalCode].filter(Boolean).join(", ") || null}</KV></div>
            {(pt.guardianName || pt.emergencyContactName) && <div className="col-span-2"><KV label="Guardian / emergency contact">{[pt.guardianName && `${pt.guardianName}${pt.guardianRelation ? ` (${pt.guardianRelation})` : ""} ${pt.guardianMobile ?? ""}`, pt.emergencyContactName && `${pt.emergencyContactName} ${pt.emergencyContactMobile ?? ""}`].filter(Boolean).join(" · ")}</KV></div>}
          </dl>
        </Card>
        <div className="space-y-4 lg:col-span-2">
          <Allergies patientId={pt.id} />
          <FilesCard patientId={pt.id} />
          <Card title="Visits and admissions">
            {enc.isLoading ? <Spinner /> : (
              <Table head={["Visit", "Type", "Status", "Doctor", "Started"]} {...(enc.data?.data.length === 0 ? { empty: "No visits yet." } : {})}>
                {enc.data?.data.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <Td>{e.type === "OPD" && can("CONSULTATION_READ") ? <Link className="font-medium text-brand-700 hover:underline" href={`/visits/${e.id}`}>{e.encounterNumber}</Link> : e.encounterNumber}</Td>
                    <Td>{e.type}</Td><Td><StatusBadge value={e.status} /></Td><Td>{e.practitionerName ?? "—"}</Td><Td>{dateTime(e.startedAt)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          {can("INVOICE_READ") && (
            <Card title="Bills">
              <Table head={["Bill", "Kind", "Status", "Total", "Due"]} {...(inv.data?.data.length === 0 ? { empty: "No bills yet." } : {})}>
                {inv.data?.data.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-50">
                    <Td><Link className="font-medium text-brand-700 hover:underline" href={`/billing/${i.id}`}>{i.invoiceNumber ?? "Draft"}</Link></Td><Td>{i.kind}</Td><Td><StatusBadge value={i.status} /></Td><Td>{money(i.total)}</Td><Td>{money(i.balanceDue)}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </div>
      </div>
      {visit && <StartVisit patientId={pt.id} onClose={() => setVisit(false)} />}
      {editing && <EditPatientModal patient={pt as EditablePatient} onClose={() => setEditing(false)} />}
    </Gate>
  );
}
