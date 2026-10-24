"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Input, Select, useDebounced } from "./ui";

export interface RxItem {
  id?: string; medicineId?: string | undefined; genericName: string; brandName?: string | undefined; strength?: string | undefined; dosage: string; route: string; frequency: string;
  frequencyText?: string | undefined; durationDays?: number | undefined; quantity?: number | undefined; instructions?: string | undefined; status?: string;
}

export const blankItem = (): RxItem => ({ genericName: "", dosage: "1 tablet", route: "ORAL", frequency: "BD", durationDays: 3 });

/** Drops empty optional fields so the payload satisfies the API's strict schema. */
export function toPayload(i: RxItem) {
  return {
    ...(i.medicineId ? { medicineId: i.medicineId } : {}), genericName: i.genericName.trim(), ...(i.brandName ? { brandName: i.brandName } : {}), ...(i.strength ? { strength: i.strength } : {}),
    dosage: i.dosage.trim() || "1", route: i.route, frequency: i.frequency, ...(i.frequency === "OTHER" && i.frequencyText ? { frequencyText: i.frequencyText } : {}),
    ...(i.durationDays ? { durationDays: i.durationDays } : {}), ...(i.quantity ? { quantity: i.quantity } : {}), ...(i.instructions?.trim() ? { instructions: i.instructions.trim() } : {}),
  };
}

function MedicineInput({ item, onChange, disabled }: { item: RxItem; onChange: (patch: Partial<RxItem>) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const term = useDebounced(item.genericName.trim(), 250);
  const res = useQuery({ queryKey: ["med-search", term], queryFn: () => api.page<{ id: string; brandName: string; genericName: string; strength: string | null }>("/medicines", { q: term, pageSize: 6 }), enabled: open && term.length >= 2 });
  return (
    <div className="relative">
      <Input aria-label="Medicine" disabled={disabled} placeholder="Medicine name" value={item.genericName} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => onChange({ genericName: e.target.value, medicineId: undefined })} />
      {open && (res.data?.data.length ?? 0) > 0 && (
        <ul className="absolute z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg">
          {res.data!.data.map((m) => (
            <li key={m.id} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-brand-50" onMouseDown={() => { onChange({ medicineId: m.id, genericName: m.genericName, brandName: m.brandName, ...(m.strength ? { strength: m.strength } : {}) }); setOpen(false); }}>
              {m.brandName} <span className="text-slate-500">· {m.genericName} {m.strength}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ROUTES = ["ORAL", "IV", "IM", "SC", "TOPICAL", "OTHER"];
const FREQS = ["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT", "OTHER"];

/** Editable (or read-only) list of prescription lines, shared by the OPD consultation and the IPD orders tab. */
export function RxRows({ items, setItems, disabled }: { items: RxItem[]; setItems: (x: RxItem[]) => void; disabled: boolean }) {
  const patch = (i: number, p: Partial<RxItem>) => setItems(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-12 items-start gap-2 rounded-md border border-slate-100 p-2">
          <div className="col-span-12 sm:col-span-4"><MedicineInput item={it} disabled={disabled} onChange={(p) => patch(i, p)} /></div>
          <Input className="col-span-4 sm:col-span-2" aria-label="Dose" placeholder="Dose" disabled={disabled} value={it.dosage} onChange={(e) => patch(i, { dosage: e.target.value })} />
          <Select className="col-span-4 sm:col-span-1" aria-label="Route" disabled={disabled} value={it.route} onChange={(e) => patch(i, { route: e.target.value })}>{ROUTES.map((r) => <option key={r}>{r}</option>)}</Select>
          <Select className="col-span-4 sm:col-span-2" aria-label="Frequency" disabled={disabled} value={it.frequency} onChange={(e) => patch(i, { frequency: e.target.value })}>{FREQS.map((r) => <option key={r}>{r}</option>)}</Select>
          <Input className="col-span-3 sm:col-span-1" aria-label="Days" placeholder="Days" inputMode="numeric" disabled={disabled} value={it.durationDays ?? ""} onChange={(e) => patch(i, { durationDays: e.target.value ? Number(e.target.value) : undefined })} />
          <Input className="col-span-3 sm:col-span-1" aria-label="Quantity" placeholder="Qty" inputMode="numeric" disabled={disabled} value={it.quantity ?? ""} onChange={(e) => patch(i, { quantity: e.target.value ? Number(e.target.value) : undefined })} />
          {!disabled && <button className="col-span-1 text-slate-400 hover:text-red-700" aria-label="Remove medicine" onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>}
          {it.frequency === "OTHER" && <Input className="col-span-12" placeholder="Describe the frequency" aria-label="Frequency text" disabled={disabled} value={it.frequencyText ?? ""} onChange={(e) => patch(i, { frequencyText: e.target.value })} />}
          <Input className="col-span-12" placeholder="Instructions (optional)" aria-label="Instructions" disabled={disabled} value={it.instructions ?? ""} onChange={(e) => patch(i, { instructions: e.target.value })} />
        </div>
      ))}
      {items.length === 0 && <p className="text-sm text-slate-500">No medicines prescribed.</p>}
    </div>
  );
}
