"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { patientName, type PatientRow } from "./shell";
import { Input, useDebounced } from "./ui";

export interface PickedPatient { id: string; name: string; mrn: string | null }

/** Type-ahead patient selector (MRN, mobile or name). Calls onPick with the chosen patient. */
export function PatientPicker({ value, onPick, autoFocus }: { value: PickedPatient | null; onPick: (p: PickedPatient | null) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["picker-patients", term], queryFn: () => api.page<PatientRow>("/patients", { q: term, pageSize: 6 }), enabled: term.length >= 2 && !value });
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm">
        <span><span className="font-medium">{value.name}</span> <span className="text-slate-500">· {value.mrn}</span></span>
        <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => { onPick(null); setQ(""); }}>change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input autoFocus={autoFocus} placeholder="Search patient by MRN, mobile or name" aria-label="Patient" value={q} onChange={(e) => setQ(e.target.value)} />
      {term.length >= 2 && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {res.isLoading && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
          {res.data?.data.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No patients found</li>}
          {res.data?.data.map((p) => (
            <li key={p.id} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-brand-50" onClick={() => onPick({ id: p.id, name: patientName(p), mrn: p.mrn })}>
              {patientName(p)} <span className="text-slate-500">· {p.mrn} · {p.mobile ?? "no mobile"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Today's date (YYYY-MM-DD) in a given time zone. */
export const todayIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** Available beds with readable labels, from the bed board (ward and room names are only on the board). */
export function useAvailableBeds() {
  return useQuery({
    queryKey: ["beds-available"],
    queryFn: async () => {
      const b = await api.get<{ wards: { name: string; rooms: { name: string; beds: { id: string; code: string; status: string; dailyRate: string }[] }[] }[] }>("/beds/board");
      return b.wards.flatMap((w) => w.rooms.flatMap((r) => r.beds.filter((x) => x.status === "AVAILABLE").map((x) => ({ id: x.id, label: `${w.name} · ${r.name} · ${x.code}`, dailyRate: x.dailyRate }))));
    },
  });
}