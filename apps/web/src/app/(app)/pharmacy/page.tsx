"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { AdjustModal, PurchasesTab, SalesTab, SuppliersTab } from "@/components/pharmacy-extras";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Tabs, Td, useDebounced } from "@/components/ui";
import { api, ApiError, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";

interface QItem { id: string; lineNo: number; medicineId: string | null; genericName: string; brandName: string | null; strength: string | null; dosage: string; frequency: string; durationDays: number | null; quantity: number | null; dispensedQuantity: number; remaining: number | null; status: string }
interface QOrder { id: string; orderNumber: string | null; signedAt: string; patientId: string; patientName: string; mrn: string | null; doctorName: string | null; status: string; allergyWarnings: { allergen: string; matchedItem: string; severity: string }[]; items: QItem[] }
interface StockRow { medicineId: string; brandName: string; genericName: string; strength: string | null; sellableQuantity: number; expiredQuantity: number; nearExpiryQuantity: number; blockedQuantity: number; reorderLevel: number; lowStock: boolean; batches: { id: string; batchNo: string; expiryDate: string; quantity: number; sellingPrice: string }[] }
interface DispenseResult { dispense: { dispenseNumber: string; total: string; invoiceId: string | null }; receipt: { receiptNumber: string; total: string } | null }
interface Med { id: string; brandName: string; genericName: string; strength: string | null }

function MedPick({ value, onPick }: { value: Med | null; onPick: (m: Med | null) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["med-pick", term], queryFn: () => api.page<Med>("/medicines", { q: term, pageSize: 6 }), enabled: term.length >= 2 && !value });
  if (value) return <div className="flex items-center justify-between rounded border border-slate-300 bg-slate-50 px-2 py-1 text-sm"><span>{value.brandName} {value.strength}</span><button className="text-xs text-brand-700" onClick={() => onPick(null)}>change</button></div>;
  return (
    <div className="relative">
      <Input aria-label="Medicine" placeholder="Search medicine" value={q} onChange={(e) => setQ(e.target.value)} />
      {term.length >= 2 && res.data && <ul className="absolute z-30 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg">{res.data.data.map((m) => <li key={m.id} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-brand-50" onClick={() => onPick(m)}>{m.brandName} <span className="text-slate-500">· {m.genericName} {m.strength}</span></li>)}</ul>}
    </div>
  );
}

function Dispense({ order, onClose }: { order: QOrder; onClose: () => void }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const [rows, setRows] = useState(() => order.items.filter((i) => i.status === "ACTIVE" && (i.remaining === null || i.remaining > 0)).map((i) => ({ item: i, med: i.medicineId ? ({ id: i.medicineId, brandName: i.brandName ?? i.genericName, genericName: i.genericName, strength: i.strength } as Med) : null, qty: String(i.remaining ?? 1) })));
  const [ack, setAck] = useState(false);
  const [needAck, setNeedAck] = useState(false);
  const [key] = useState(newKey);
  const [done, setDone] = useState<DispenseResult | null>(null);
  const [method, setMethod] = useState("CASH");
  const [ref, setRef] = useState("");
  const dispense = useMutation({
    mutationFn: () => api.post<DispenseResult>("/pharmacy/dispenses", {
      patientId: order.patientId, medicationOrderId: order.id,
      items: rows.filter((r) => r.med && Number(r.qty) > 0).map((r) => ({ medicationOrderItemId: r.item.id, medicineId: r.med!.id, quantity: Number(r.qty) })),
      ...(ack ? { acknowledgeAllergyWarnings: true } : {}),
    }, key),
    onSuccess: (r) => { setDone(r); void qc.invalidateQueries({ queryKey: ["pharmacy-queue"] }); void qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); },
    onError: (e) => { if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setNeedAck(true); },
  });
  const openShift = useMutation({ mutationFn: () => api.post("/shifts/open", { openingCash: "0" }), onSuccess: () => pay.mutate() });
  const pay = useMutation({
    mutationFn: () => api.post(`/invoices/${done!.dispense.invoiceId}/payments`, { payments: [{ method, amount: done!.dispense.total, ...(ref ? { reference: ref } : {}) }] }, newKey()),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["pharmacy-queue"] }); onClose(); },
  });
  if (done) {
    return (
      <Modal title={`Dispensed — ${done.dispense.dispenseNumber}`} onClose={onClose}>
        <div className="space-y-3">
          <Notice tone="success">Total {money(done.dispense.total)}. Stock has been deducted from the earliest-expiring batches.</Notice>
          {done.dispense.invoiceId && can("PAYMENT_CREATE") && !done.receipt && (
            <div className="grid grid-cols-3 gap-2">
              <Select aria-label="Mode" value={method} onChange={(e) => setMethod(e.target.value)}><option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card</option></Select>
              <Input aria-label="Reference" placeholder={method === "CASH" ? "—" : "Reference"} disabled={method === "CASH"} value={ref} onChange={(e) => setRef(e.target.value)} />
              <Button loading={pay.isPending} onClick={() => pay.mutate()}>Receive {money(done.dispense.total)}</Button>
              <div className="col-span-3 space-y-2">
                <ErrorNote error={pay.error ?? openShift.error} />
                {pay.error instanceof ApiError && pay.error.code === "SHIFT_NOT_OPEN" && can("CASHIER_SHIFT_MANAGE") && <Button variant="secondary" loading={openShift.isPending} onClick={() => openShift.mutate()}>Open my cash shift (₹0 opening) and retry</Button>}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            {done.dispense.invoiceId && <Link href={`/billing/${done.dispense.invoiceId}`} className="self-center text-sm text-brand-700 hover:underline">Open bill</Link>}
            {done.dispense.invoiceId && <a href={printUrl(`invoices/${done.dispense.invoiceId}`)} target="_blank" rel="noreferrer" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">Print bill</a>}
            <Button variant="secondary" onClick={onClose}>Done</Button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Dispense — ${order.patientName}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">Prescription {order.orderNumber} by {order.doctorName ?? "doctor"}</p>
        {order.allergyWarnings.length > 0 && <Notice tone="warn">Allergy alert: {order.allergyWarnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</Notice>}
        <Table head={["Prescribed", "Medicine to dispense", "Qty"]}>
          {rows.map((r, i) => (
            <tr key={r.item.id}>
              <Td><div className="font-medium">{r.item.genericName} {r.item.strength}</div><div className="text-xs text-slate-500">{r.item.dosage} · {r.item.frequency}{r.item.durationDays ? ` · ${r.item.durationDays} d` : ""} · remaining {r.item.remaining ?? "—"}</div></Td>
              <Td><MedPick value={r.med} onPick={(m) => setRows(rows.map((x, j) => (j === i ? { ...x, med: m } : x)))} /></Td>
              <Td><Input aria-label="Quantity" className="w-20" inputMode="numeric" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></Td>
            </tr>
          ))}
        </Table>
        {needAck && <label className="flex items-center gap-2 text-sm text-amber-900"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have checked the allergy warning with the prescriber and want to continue.</label>}
        <ErrorNote error={dispense.error instanceof ApiError && dispense.error.code === "ALLERGY_CONFLICT" ? null : dispense.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={rows.every((r) => !r.med || !Number(r.qty)) || (needAck && !ack)} loading={dispense.isPending} onClick={() => dispense.mutate()}>Dispense</Button></div>
      </div>
    </Modal>
  );
}

function AddBatch({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [med, setMed] = useState<Med | null>(null);
  const [f, setF] = useState({ batchNo: "", expiryDate: "", mrp: "", purchasePrice: "", sellingPrice: "", quantity: "" });
  const [key] = useState(newKey);
  const m = useMutation({ mutationFn: () => api.post("/pharmacy/batches", { medicineId: med!.id, ...f, quantity: Number(f.quantity) }, key), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); onClose(); } });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add opening stock (new batch)" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><Field as="div" label="Medicine"><MedPick value={med} onPick={setMed} /></Field></div>
        <Field label="Batch number"><Input value={f.batchNo} onChange={set("batchNo")} /></Field>
        <Field label="Expiry date"><Input type="date" value={f.expiryDate} onChange={set("expiryDate")} /></Field>
        <Field label="MRP"><Input inputMode="decimal" value={f.mrp} onChange={set("mrp")} /></Field>
        <Field label="Purchase price"><Input inputMode="decimal" value={f.purchasePrice} onChange={set("purchasePrice")} /></Field>
        <Field label="Selling price"><Input inputMode="decimal" value={f.sellingPrice} onChange={set("sellingPrice")} /></Field>
        <Field label="Quantity"><Input inputMode="numeric" value={f.quantity} onChange={set("quantity")} /></Field>
        <div className="col-span-2"><ErrorNote error={m.error} /></div>
        <div className="col-span-2 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!med || Object.values(f).some((v) => !v)} loading={m.isPending} onClick={() => m.mutate()}>Add stock</Button></div>
      </div>
    </Modal>
  );
}

export default function PharmacyPage() {
  const { can, date } = useMe();
  const [tab, setTab] = useState<"queue" | "stock" | "sales" | "purchases" | "suppliers">(can("PHARMACY_DISPENSE") ? "queue" : "stock");
  const [order, setOrder] = useState<QOrder | null>(null);
  const [adding, setAdding] = useState(false);
  const [adjusting, setAdjusting] = useState<{ id: string; label: string; quantity: number } | null>(null);
  const [low, setLow] = useState(false);
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const queue = useQuery({ queryKey: ["pharmacy-queue"], queryFn: () => api.page<QOrder>("/pharmacy/queue", { pageSize: 50 }), enabled: tab === "queue", refetchInterval: 20_000 });
  const stock = useQuery({ queryKey: ["pharmacy-stock", low, term], queryFn: () => api.page<StockRow>("/pharmacy/stock", { ...(low ? { lowStock: "true" } : {}), ...(term.length >= 2 ? { q: term } : {}), pageSize: 50 }), enabled: tab === "stock" });
  return (
    <Gate anyOf={["PHARMACY_READ"]} feature="PHARMACY_ENABLED">
      <PageHeader title="Pharmacy" actions={can("PHARMACY_ADJUST_STOCK", "PHARMACY_PURCHASE") ? <Button variant="secondary" onClick={() => setAdding(true)}>Add stock</Button> : undefined} />
      <Tabs tabs={[{ id: "queue", label: "Prescription queue" }, { id: "stock", label: "Stock" }, { id: "sales", label: "Sales" }, { id: "purchases", label: "Purchases" }, { id: "suppliers", label: "Suppliers" }]} value={tab} onChange={setTab} />
      {tab === "sales" && <SalesTab />}
      {tab === "purchases" && <PurchasesTab />}
      {tab === "suppliers" && <SuppliersTab />}
      {tab === "queue" && (
        <Card>
          {queue.isLoading ? <Spinner /> : (
            <Table head={["Patient", "Prescription", "Doctor", "Status", ""]} {...(queue.data?.data.length === 0 ? { empty: "No prescriptions waiting." } : {})}>
              {queue.data?.data.map((o) => (
                <tr key={o.id}>
                  <Td><span className="font-medium">{o.patientName}</span> <span className="text-slate-500">· {o.mrn}</span>{o.allergyWarnings.length > 0 && <> <Badge tone="red">allergy alert</Badge></>}</Td>
                  <Td>{o.orderNumber}<div className="text-xs text-slate-500">{o.items.length} item(s) · {date(o.signedAt)}</div></Td><Td>{o.doctorName}</Td><Td><Badge tone={o.status === "PARTIAL" ? "amber" : "gray"}>{o.status.toLowerCase()}</Badge></Td>
                  <Td>{can("PHARMACY_DISPENSE") && <Button onClick={() => setOrder(o)}>Dispense</Button>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {tab === "stock" && (
        <Card actions={<><Input placeholder="Search medicine" aria-label="Search medicine" className="w-48" value={q} onChange={(e) => setQ(e.target.value)} /><label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Low stock only</label></>}>
          {stock.isLoading ? <Spinner /> : (
            <Table head={["Medicine", "In stock", "Reorder at", "Near expiry", "Batches (earliest expiry first)"]} {...(stock.data?.data.length === 0 ? { empty: "No stock found." } : {})}>
              {stock.data?.data.map((s) => (
                <tr key={s.medicineId}>
                  <Td><span className="font-medium">{s.brandName}</span> <span className="text-slate-500">{s.strength}</span><div className="text-xs text-slate-500">{s.genericName}</div></Td>
                  <Td>{s.sellableQuantity} {s.lowStock && <Badge tone="red">low</Badge>}</Td><Td>{s.reorderLevel}</Td><Td>{s.nearExpiryQuantity > 0 ? <Badge tone="amber">{s.nearExpiryQuantity}</Badge> : "—"}{s.expiredQuantity > 0 && <> <Badge tone="red">{s.expiredQuantity} expired</Badge></>}</Td>
                  <Td>{s.batches.length === 0 ? "—" : s.batches.map((b) => (
                    <div key={b.id} className="text-xs">{b.batchNo} ({b.quantity}, exp {b.expiryDate}){can("PHARMACY_ADJUST_STOCK") && <button className="ml-2 text-brand-700 hover:underline" onClick={() => setAdjusting({ id: b.id, label: `${s.brandName} ${s.strength ?? ""} · ${b.batchNo}`, quantity: b.quantity })}>adjust</button>}</div>
                  ))}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {order && <Dispense order={order} onClose={() => setOrder(null)} />}
      {adding && <AddBatch onClose={() => setAdding(false)} />}
      {adjusting && <AdjustModal batch={adjusting} onClose={() => setAdjusting(null)} />}
    </Gate>
  );
}
