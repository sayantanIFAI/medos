"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { PatientPicker, type PickedPatient } from "@/components/pickers";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface InvoiceRow { id: string; invoiceNumber: string | null; status: string; kind: string; patientName: string; mrn: string | null; total: string; balanceDue: string; createdAt: string }
interface Service { id: string; code: string; name: string; price: string; taxPercent: string; category: string }
interface Shift { id: string; openedAt: string; openingCash: string; expectedCash?: string; cashReceived?: string; cashRefunded?: string; receiptsTotal?: string }
type Line = { serviceId?: string; description: string; unitPrice: string; taxPercent: string; quantity: string };

function NewBill({ initialPatient, onClose }: { initialPatient: PickedPatient | null; onClose: () => void }) {
  const router = useRouter();
  const { money } = useMe();
  const [patient, setPatient] = useState<PickedPatient | null>(initialPatient);
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState("");
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<Service>("/services", { pageSize: 100 }) });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/invoices", {
      patientId: patient!.id,
      lines: lines.map((l) => (l.serviceId ? { serviceId: l.serviceId, quantity: l.quantity } : { description: l.description, unitPrice: l.unitPrice, taxPercent: l.taxPercent || "0", quantity: l.quantity })),
    }),
    onSuccess: (inv) => router.push(`/billing/${inv.id}`),
  });
  const matches = (services.data?.data ?? []).filter((s) => !q || `${s.code} ${s.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const total = lines.reduce((n, l) => n + Number(l.unitPrice || 0) * Number(l.quantity || 0) * (1 + Number(l.taxPercent || 0) / 100), 0);
  return (
    <Modal title="New bill" onClose={onClose} wide>
      <div className="space-y-3">
        <Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus={!initialPatient} /></Field>
        <Field label="Add a service"><Input placeholder="Search price list…" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <div className="flex flex-wrap gap-1.5">
          {matches.map((s) => <button key={s.id} className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-brand-50" onClick={() => setLines([...lines, { serviceId: s.id, description: s.name, unitPrice: s.price, taxPercent: s.taxPercent, quantity: "1" }])}>{s.name} · {money(s.price)}</button>)}
          <button className="rounded border border-dashed border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50" onClick={() => setLines([...lines, { description: "", unitPrice: "", taxPercent: "0", quantity: "1" }])}>+ Other charge</button>
        </div>
        {lines.length > 0 && (
          <Table head={["Item", "Qty", "Rate", "Tax %", ""]}>
            {lines.map((l, i) => (
              <tr key={i}>
                <Td>{l.serviceId ? l.description : <Input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />}</Td>
                <Td><Input aria-label="Quantity" className="w-20" inputMode="decimal" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></Td>
                <Td>{l.serviceId ? money(l.unitPrice) : <Input aria-label="Rate" className="w-24" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />}</Td>
                <Td>{l.serviceId ? l.taxPercent : <Input aria-label="Tax percent" className="w-16" inputMode="decimal" value={l.taxPercent} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, taxPercent: e.target.value } : x)))} />}</Td>
                <Td><button aria-label="Remove line" className="text-slate-400 hover:text-red-700" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-500">Estimated total {money(total.toFixed(2))} — the final amount is calculated by the server.</span>
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || lines.length === 0 || lines.some((l) => !l.description || !l.unitPrice)} loading={create.isPending} onClick={() => create.mutate()}>Create bill</Button></div>
        </div>
        <ErrorNote error={create.error} />
      </div>
    </Modal>
  );
}

function ShiftCard() {
  const { money, dateTime, can } = useMe();
  const qc = useQueryClient();
  const cur = useQuery({ queryKey: ["shift"], queryFn: () => api.get<Shift | null>("/shifts/current") });
  const [cash, setCash] = useState("");
  const [closing, setClosing] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["shift"] });
  const open = useMutation({ mutationFn: () => api.post("/shifts/open", { openingCash: cash || "0" }), onSuccess: () => { setCash(""); void refresh(); } });
  const close = useMutation({ mutationFn: () => api.post(`/shifts/${cur.data!.id}/close`, { actualCash: cash || "0" }), onSuccess: () => { setCash(""); setClosing(false); void refresh(); } });
  if (!can("CASHIER_SHIFT_MANAGE")) return null;
  return (
    <Card title="My cash shift">
      {cur.isLoading ? <Spinner /> : cur.data ? (
        <div className="space-y-2 text-sm">
          <div>Open since {dateTime(cur.data.openedAt)} · opening cash {money(cur.data.openingCash)}{cur.data.expectedCash ? ` · expected in drawer ${money(cur.data.expectedCash)}` : ""}</div>
          {closing ? (
            <div className="flex items-end gap-2"><Field label="Cash counted in drawer"><Input autoFocus inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} /></Field><Button loading={close.isPending} onClick={() => close.mutate()}>Close shift</Button><Button variant="ghost" onClick={() => setClosing(false)}>Back</Button></div>
          ) : <Button variant="secondary" onClick={() => setClosing(true)}>Close shift…</Button>}
          <ErrorNote error={close.error} />
        </div>
      ) : (
        <div className="space-y-2">
          <Notice tone="warn">Open a shift before taking cash payments.</Notice>
          <div className="flex items-end gap-2"><Field label="Opening cash"><Input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" /></Field><Button loading={open.isPending} onClick={() => open.mutate()}>Open shift</Button></div>
          <ErrorNote error={open.error} />
        </div>
      )}
    </Card>
  );
}

function BillingInner() {
  const { can, money, date } = useMe();
  const params = useSearchParams();
  const [adding, setAdding] = useState(!!params.get("patient"));
  const [status, setStatus] = useState("");
  const [qNum, setQNum] = useState("");
  const pre = params.get("patient");
  const preP = useQuery({ queryKey: ["pre-patient", pre], queryFn: () => api.get<{ id: string; mrn: string | null; firstName: string; lastName: string | null }>(`/patients/${pre}`), enabled: !!pre });
  const list = useQuery({ queryKey: ["invoices", status, qNum], queryFn: () => api.page<InvoiceRow>("/invoices", { ...(status === "OUTSTANDING" ? { outstanding: "true" } : status ? { status } : {}), ...(qNum ? { q: qNum } : {}), pageSize: 50 }) });
  return (
    <Gate anyOf={["INVOICE_READ"]}>
      <PageHeader title="Billing" subtitle="Bills, payments and your cash shift" actions={can("INVOICE_CREATE") ? <Button onClick={() => setAdding(true)}>New bill</Button> : undefined} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Bills" actions={<>
            <Input placeholder="Bill number" aria-label="Bill number" className="w-36" value={qNum} onChange={(e) => setQNum(e.target.value)} />
            <Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="OUTSTANDING">Outstanding</option><option value="DRAFT">Draft</option><option value="PAID">Paid</option><option value="CANCELLED">Cancelled</option></Select>
          </>}>
            {list.isLoading ? <Spinner /> : (
              <Table head={["Bill", "Patient", "Status", "Total", "Due", "Date"]} {...(list.data?.data.length === 0 ? { empty: "No bills found." } : {})}>
                {list.data?.data.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-50">
                    <Td><Link className="font-medium text-brand-700 hover:underline" href={`/billing/${i.id}`}>{i.invoiceNumber ?? "Draft"}</Link> <Badge>{i.kind.toLowerCase()}</Badge></Td>
                    <Td>{i.patientName}<div className="text-xs text-slate-500">{i.mrn}</div></Td><Td><StatusBadge value={i.status} /></Td><Td>{money(i.total)}</Td><Td>{money(i.balanceDue)}</Td><Td>{date(i.createdAt)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
        <ShiftCard />
      </div>
      {adding && <NewBill initialPatient={preP.data ? { id: preP.data.id, mrn: preP.data.mrn, name: [preP.data.firstName, preP.data.lastName].filter(Boolean).join(" ") } : null} onClose={() => setAdding(false)} />}
    </Gate>
  );
}

export default function BillingPage() { return <Suspense fallback={<Spinner />}><BillingInner /></Suspense>; }
