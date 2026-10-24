"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Gate } from "@/components/gate";
import { patientName, type PatientRow } from "@/components/shell";
import { Button, Card, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Td, useDebounced } from "@/components/ui";
import { api, ApiError, newKey } from "@/lib/api";
import { ageText } from "@/lib/format";
import { useMe } from "@/lib/me";

const schema = z.object({
  firstName: z.string().trim().min(1, "Enter the first name"),
  lastName: z.string().trim().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]),
  ageMode: z.enum(["age", "dob"]),
  age: z.string().optional(),
  dob: z.string().optional(),
  mobile: z.string().trim().optional(),
  addressLine: z.string().trim().optional(),
  city: z.string().trim().optional(),
  postalCode: z.string().trim().optional(),
}).superRefine((v, c) => {
  if (v.ageMode === "age" && !(Number(v.age) >= 0 && Number(v.age) <= 130 && v.age !== "")) c.addIssue({ code: "custom", path: ["age"], message: "Enter the age in years" });
  if (v.ageMode === "dob" && !v.dob) c.addIssue({ code: "custom", path: ["dob"], message: "Enter the date of birth" });
});
type Form = z.infer<typeof schema>;

interface Candidate { patient: PatientRow; severity: string; reasons: string[]; similarity: number }

function RegisterPatient({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { can } = useMe();
  const { register, handleSubmit, watch, formState: { errors, isSubmitting }, getValues } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { gender: "FEMALE", ageMode: "age" } });
  const [error, setError] = useState<unknown>(null);
  const [dups, setDups] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  const mode = watch("ageMode");

  const body = (v: Form, override: boolean) => ({
    firstName: v.firstName, ...(v.lastName ? { lastName: v.lastName } : {}), gender: v.gender,
    ...(v.ageMode === "age" ? { estimatedAgeYears: Number(v.age) } : { dateOfBirth: v.dob }),
    ...(v.mobile ? { mobile: v.mobile } : {}), ...(v.addressLine ? { addressLine: v.addressLine } : {}), ...(v.city ? { city: v.city } : {}), ...(v.postalCode ? { postalCode: v.postalCode } : {}),
    ...(override ? { duplicateOverride: { confirmedDistinct: true, reason: "Confirmed as a different person at registration" } } : {}),
  });
  async function save(v: Form, override = false) {
    setError(null); setBusy(true);
    try {
      const p = await api.post<{ id: string }>("/patients", body(v, override), override ? newKey() : key);
      router.push(`/patients/${p.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "DUPLICATE_PATIENT_SUSPECTED") setDups(((e.details as { candidates?: Candidate[] } | undefined)?.candidates) ?? []);
      else setError(e);
    } finally { setBusy(false); }
  }

  if (dups) {
    return (
      <Modal title="This patient may already be registered" onClose={onClose} wide>
        <div className="space-y-3">
          <Notice tone="warn">Please check these existing patients before creating a new record.</Notice>
          <Table head={["Patient", "MRN", "Mobile", "Match", ""]}>
            {dups.map((d) => (
              <tr key={d.patient.id}>
                <Td>{patientName(d.patient)} <span className="text-slate-500">· {d.patient.gender.toLowerCase()}{ageText(d.patient.age) ? `, ${ageText(d.patient.age)}` : ""}</span></Td>
                <Td>{d.patient.mrn}</Td><Td>{d.patient.mobile ?? "—"}</Td>
                <Td><span className="text-xs text-slate-600">{d.reasons.join(", ").replace(/_/g, " ").toLowerCase()}</span></Td>
                <Td><Button variant="secondary" onClick={() => router.push(`/patients/${d.patient.id}`)}>Use this patient</Button></Td>
              </tr>
            ))}
          </Table>
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDups(null)}>Back</Button>
            {can("DUPLICATE_OVERRIDE")
              ? <Button loading={busy} onClick={() => save(getValues(), true)}>This is a different person — register</Button>
              : <span className="self-center text-sm text-slate-500">Ask a supervisor to register despite a possible duplicate.</span>}
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Register new patient" onClose={onClose} wide>
      <form onSubmit={handleSubmit((v) => save(v))} className="grid grid-cols-1 gap-3 sm:grid-cols-2" noValidate>
        <Field label="First name" error={errors.firstName?.message}><Input autoFocus {...register("firstName")} /></Field>
        <Field label="Last name" error={errors.lastName?.message}><Input {...register("lastName")} /></Field>
        <Field label="Gender"><Select {...register("gender")}><option value="FEMALE">Female</option><option value="MALE">Male</option><option value="OTHER">Other</option><option value="UNKNOWN">Unknown</option></Select></Field>
        <Field label="Mobile" hint="10-digit Indian number" error={errors.mobile?.message}><Input inputMode="tel" {...register("mobile")} /></Field>
        <div>
          <div className="mb-1 flex gap-3 text-sm font-medium text-slate-700">
            <label className="flex items-center gap-1"><input type="radio" value="age" {...register("ageMode")} /> Age</label>
            <label className="flex items-center gap-1"><input type="radio" value="dob" {...register("ageMode")} /> Date of birth</label>
          </div>
          {mode === "age" ? <Input inputMode="numeric" placeholder="Years" aria-label="Age in years" {...register("age")} /> : <Input type="date" aria-label="Date of birth" {...register("dob")} />}
          {(errors.age || errors.dob) && <span className="mt-1 block text-xs text-red-600" role="alert">{errors.age?.message ?? errors.dob?.message}</span>}
        </div>
        <Field label="Address"><Input {...register("addressLine")} /></Field>
        <Field label="City"><Input {...register("city")} /></Field>
        <Field label="PIN code"><Input inputMode="numeric" {...register("postalCode")} /></Field>
        <div className="sm:col-span-2"><ErrorNote error={error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={isSubmitting || busy}>Register</Button></div>
      </form>
    </Modal>
  );
}

export default function PatientsPage() {
  const { can, date } = useMe();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["patients", term], queryFn: () => api.page<PatientRow & { createdAt: string }>("/patients", { q: term, pageSize: 25 }), enabled: term.length >= 2 });
  return (
    <Gate anyOf={["PATIENT_READ"]}>
      <PageHeader title="Patients" subtitle="Search by MRN, mobile number or name" actions={can("PATIENT_CREATE") ? <Button onClick={() => setAdding(true)}>Register patient</Button> : undefined} />
      <Card>
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least 2 characters…" aria-label="Search patients" className="mb-3 max-w-md" />
        {term.length < 2 ? <p className="py-6 text-center text-sm text-slate-500">Start typing to find a patient.</p>
          : res.isLoading ? <Spinner />
          : <>
            <ErrorNote error={res.error} />
            <Table head={["Name", "MRN", "Gender / age", "Mobile", "Registered"]} {...(res.data?.data.length === 0 ? { empty: "No patients match. Check the spelling or register a new patient." } : {})}>
              {res.data?.data.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <Td><Link className="font-medium text-brand-700 hover:underline" href={`/patients/${p.id}`}>{patientName(p)}</Link></Td>
                  <Td>{p.mrn}</Td><Td>{p.gender.toLowerCase()}{ageText(p.age) ? `, ${ageText(p.age)}` : ""}</Td><Td>{p.mobile ?? "—"}</Td><Td>{date(p.createdAt)}</Td>
                </tr>
              ))}
            </Table>
          </>}
      </Card>
      {adding && <RegisterPatient onClose={() => setAdding(false)} />}
    </Gate>
  );
}
