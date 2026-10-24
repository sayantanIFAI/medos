"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { PatientPicker, todayIn, type PickedPatient } from "@/components/pickers";
import { Button, Card, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Table, Td } from "@/components/ui";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Appt { practitionerId: string; id: string; startAt: string; status: string; patientName: string; mrn: string | null; practitionerName: string; departmentName: string | null; type: string; patientId: string; version: number }
interface Slot { startAt: string; endAt: string; available: boolean }
interface Doc { id: string; displayName: string }

function Book({ date, onClose }: { date: string; onClose: () => void }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [doc, setDoc] = useState("");
  const [day, setDay] = useState(date);
  const [slot, setSlot] = useState("");
  const slots = useQuery({ queryKey: ["slots", doc, day], queryFn: () => api.get<Slot[]>(`/practitioners/${doc}/availability`, { date: day }), enabled: !!doc });
  const { dateTime } = useMe();
  const book = useMutation({ mutationFn: () => api.post("/appointments", { patientId: patient!.id, practitionerId: doc, startAt: slot }), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["appointments"] }); onClose(); } });
  return (
    <Modal title="Book appointment" onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus /></Field></div>
        <Field label="Doctor"><Select value={doc} onChange={(e) => { setDoc(e.target.value); setSlot(""); }}><option value="">Choose…</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
        <Field label="Date"><Input type="date" value={day} min={date} onChange={(e) => { setDay(e.target.value); setSlot(""); }} /></Field>
        <div className="sm:col-span-2">
          <div className="mb-1 text-sm font-medium text-slate-700">Time</div>
          {!doc ? <p className="text-sm text-slate-500">Choose a doctor to see free times.</p> : slots.isLoading ? <Spinner /> : slots.data?.length === 0 ? <p className="text-sm text-slate-500">This doctor does not see patients on that day.</p> : (
            <div className="flex flex-wrap gap-1.5">
              {slots.data?.map((s) => (
                <button key={s.startAt} disabled={!s.available} onClick={() => setSlot(s.startAt)} className={`rounded border px-2 py-1 text-sm ${slot === s.startAt ? "border-brand-600 bg-brand-600 text-white" : s.available ? "border-slate-300 hover:bg-brand-50" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 line-through"}`}>
                  {dateTime(s.startAt).split(", ").pop()}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="sm:col-span-2"><ErrorNote error={book.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || !doc || !slot} loading={book.isPending} onClick={() => book.mutate()}>Book</Button></div>
      </div>
    </Modal>
  );
}

function WalkIn({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [doc, setDoc] = useState("");
  const [key] = useState(newKey);
  const go = useMutation({ mutationFn: () => api.post("/appointments/walk-in", { patientId: patient!.id, practitionerId: doc }, key), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["appointments"] }); await qc.invalidateQueries({ queryKey: ["queue"] }); onClose(); } });
  return (
    <Modal title="Walk-in patient" onClose={onClose}>
      <div className="space-y-3">
        <Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus /></Field>
        <Field label="Doctor"><Select value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">Choose…</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
        <ErrorNote error={go.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || !doc} loading={go.isPending} onClick={() => go.mutate()}>Check in and add to queue</Button></div>
      </div>
    </Modal>
  );
}

/** Move a booked appointment to another time (and optionally another doctor). The version guards against concurrent changes. */
function Reschedule({ appt, today, onClose }: { appt: Appt; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { dateTime } = useMe();
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const [doc, setDoc] = useState(appt.practitionerId);
  const [day, setDay] = useState(today);
  const [slot, setSlot] = useState("");
  const slots = useQuery({ queryKey: ["slots", doc, day], queryFn: () => api.get<Slot[]>(`/practitioners/${doc}/availability`, { date: day }) });
  const move = useMutation({
    mutationFn: () => api.patch(`/appointments/${appt.id}`, { version: appt.version, startAt: slot, ...(doc !== appt.practitionerId ? { practitionerId: doc } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["appointments"] }); onClose(); },
  });
  return (
    <Modal title={`Reschedule — ${appt.patientName}`} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <p className="text-sm text-slate-500 sm:col-span-2">Currently {dateTime(appt.startAt)} with {appt.practitionerName}.</p>
        <Field label="Doctor"><Select value={doc} onChange={(e) => { setDoc(e.target.value); setSlot(""); }}>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
        <Field label="Date"><Input type="date" min={today} value={day} onChange={(e) => { setDay(e.target.value); setSlot(""); }} /></Field>
        <div className="sm:col-span-2">
          <div className="mb-1 text-sm font-medium text-slate-700">New time</div>
          {slots.isLoading ? <Spinner /> : slots.data?.length === 0 ? <p className="text-sm text-slate-500">No sessions on that day.</p> : (
            <div className="flex flex-wrap gap-1.5">
              {slots.data?.map((s) => (
                <button key={s.startAt} disabled={!s.available} onClick={() => setSlot(s.startAt)} className={`rounded border px-2 py-1 text-sm ${slot === s.startAt ? "border-brand-600 bg-brand-600 text-white" : s.available ? "border-slate-300 hover:bg-brand-50" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 line-through"}`}>{dateTime(s.startAt).split(", ").pop()}</button>
              ))}
            </div>
          )}
        </div>
        <div className="sm:col-span-2"><ErrorNote error={move.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Keep as is</Button><Button disabled={!slot} loading={move.isPending} onClick={() => move.mutate()}>Move appointment</Button></div>
      </div>
    </Modal>
  );
}
export default function AppointmentsPage() {
  const { me, can, dateTime } = useMe();
  const qc = useQueryClient();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const today = todayIn(tz);
  const [date, setDate] = useState(today);
  const [doctor, setDoctor] = useState("");
  const [modal, setModal] = useState<"book" | "walkin" | null>(null);
  const [cancel, setCancel] = useState<Appt | null>(null);
  const [moving, setMoving] = useState<Appt | null>(null);
  const [reason, setReason] = useState("");
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const list = useQuery({ queryKey: ["appointments", date, doctor], queryFn: () => api.page<Appt>("/appointments", { date, ...(doctor ? { practitionerId: doctor } : {}), pageSize: 100 }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["appointments"] });
  const act = useMutation({ mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) => api.post(`/appointments/${id}/${action}`, body), onSuccess: async () => { await refresh(); await qc.invalidateQueries({ queryKey: ["queue"] }); } });
  return (
    <Gate anyOf={["APPOINTMENT_READ"]}>
      <PageHeader
        title="Appointments"
        actions={<>
          <Input type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          <Select aria-label="Doctor" value={doctor} onChange={(e) => setDoctor(e.target.value)} className="w-48"><option value="">All doctors</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select>
          {can("APPOINTMENT_CREATE") && <Button variant="secondary" onClick={() => setModal("walkin")}>Walk-in</Button>}
          {can("APPOINTMENT_CREATE") && <Button onClick={() => setModal("book")}>Book appointment</Button>}
        </>}
      />
      <ErrorNote error={act.error} />
      <Card>
        {list.isLoading ? <Spinner /> : (
          <Table head={["Time", "Patient", "Doctor", "Status", ""]} {...(list.data?.data.length === 0 ? { empty: "No appointments on this day." } : {})}>
            {list.data?.data.map((a) => (
              <tr key={a.id}>
                <Td>{dateTime(a.startAt).split(", ").pop()}</Td>
                <Td><span className="font-medium">{a.patientName}</span> <span className="text-slate-500">· {a.mrn}</span></Td>
                <Td>{a.practitionerName}<div className="text-xs text-slate-500">{a.departmentName}</div></Td>
                <Td><StatusBadge value={a.status} /></Td>
                <Td>
                  <div className="flex justify-end gap-1.5">
                    {a.status === "BOOKED" && can("APPOINTMENT_UPDATE", "QUEUE_MANAGE") && <Button onClick={() => act.mutate({ id: a.id, action: "check-in" })}>Check in</Button>}
                    {a.status === "BOOKED" && can("APPOINTMENT_UPDATE") && <Button variant="ghost" onClick={() => setMoving(a)}>Reschedule</Button>}
                    {a.status === "BOOKED" && can("APPOINTMENT_UPDATE") && <Button variant="ghost" onClick={() => act.mutate({ id: a.id, action: "no-show" })}>No-show</Button>}
                    {["BOOKED", "CHECKED_IN"].includes(a.status) && can("APPOINTMENT_CANCEL") && <Button variant="ghost" onClick={() => { setCancel(a); setReason(""); }}>Cancel</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {modal === "book" && <Book date={today} onClose={() => setModal(null)} />}
      {modal === "walkin" && <WalkIn onClose={() => setModal(null)} />}
      {moving && <Reschedule appt={moving} today={today} onClose={() => setMoving(null)} />}
      {cancel && (
        <Modal title={`Cancel appointment for ${cancel.patientName}?`} onClose={() => setCancel(null)}>
          <div className="space-y-3">
            <Field label="Reason"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCancel(null)}>Keep</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={() => { act.mutate({ id: cancel.id, action: "cancel", body: { reason: reason.trim() } }); setCancel(null); }}>Cancel appointment</Button></div>
          </div>
        </Modal>
      )}
    </Gate>
  );
}
