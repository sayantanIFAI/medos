"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { visibleNav } from "@/lib/nav";

function Stat({ label, value, href }: { label: string; value: string | number | undefined; href?: string }) {
  const body = (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-500">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value ?? <span className="text-slate-300">…</span>}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export default function Dashboard() {
  const { me, can, features, money } = useMe();
  const opd = useQuery({ queryKey: ["dash-opd"], queryFn: () => api.get<{ total: number }>("/reports/opd/daily"), enabled: can("REPORT_READ") });
  const col = useQuery({ queryKey: ["dash-col"], queryFn: () => api.get<{ totals: { net: string } }>("/reports/collections"), enabled: can("REPORT_READ") });
  const queue = useQuery({ queryKey: ["dash-queue"], queryFn: () => api.get<{ status: string }[]>("/queue"), enabled: can("QUEUE_READ"), refetchInterval: 20_000 });
  const adm = useQuery({ queryKey: ["dash-adm"], queryFn: () => api.page<unknown>("/admissions", { status: "ADMITTED", pageSize: 1 }), enabled: can("ADMISSION_READ") && features.IPD_ENABLED });
  const outstanding = useQuery({ queryKey: ["dash-out"], queryFn: () => api.get<{ total: number; totalDue: string }>("/reports/outstanding-invoices", { pageSize: 1 }), enabled: can("REPORT_READ") });
  const low = useQuery({ queryKey: ["dash-low"], queryFn: () => api.get<{ rows: unknown[] }>("/reports/pharmacy/low-stock"), enabled: can("REPORT_READ") && features.PHARMACY_ENABLED });
  const nav = visibleNav(new Set(me.permissions), features, me.roles).filter((n) => n.href !== "/dashboard");
  const waiting = queue.data?.filter((q) => q.status === "WAITING" || q.status === "CALLED").length;

  return (
    <>
      <PageHeader title={`Welcome, ${me.fullName}`} subtitle={`${me.facility?.name ?? ""} · ${new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: me.facility?.timezone ?? me.tenant.timezone }).format(new Date())}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {can("QUEUE_READ") && <Stat label="Waiting in OPD" value={waiting} href="/queue" />}
        {can("REPORT_READ") && <Stat label="OPD visits today" value={opd.data?.total} href="/reports" />}
        {can("REPORT_READ") && <Stat label="Collected today" value={col.data ? money(col.data.totals.net) : undefined} href="/reports" />}
        {can("REPORT_READ") && <Stat label="Outstanding bills" value={outstanding.data ? `${outstanding.data.total} · ${money(outstanding.data.totalDue)}` : undefined} href="/billing" />}
        {can("ADMISSION_READ") && features.IPD_ENABLED && <Stat label="Admitted patients" value={adm.data?.meta.total} href="/ipd" />}
        {can("REPORT_READ") && features.PHARMACY_ENABLED && <Stat label="Low-stock medicines" value={low.data?.rows.length} href="/pharmacy" />}
      </div>
      <Card title="Go to" className="mt-4">
        {nav.length === 0 ? <Spinner /> : <div className="flex flex-wrap gap-2">{nav.map((n) => <Link key={n.href} href={n.href} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-brand-50">{n.label}</Link>)}</div>}
        <p className="mt-3 text-xs text-slate-500">Tip: press <kbd className="rounded border px-1">/</kbd> anywhere to search for a patient.</p>
      </Card>
    </>
  );
}
