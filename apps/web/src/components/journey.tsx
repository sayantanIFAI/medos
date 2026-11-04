"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Badge, Card, Spinner, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

type Via = "VOICEBOT" | "OCR" | "PHONE_BOT" | "STAFF";
interface JourneyEvent { id: string; kind: "APPOINTMENT" | "LAB_BOOKING" | "PRESCRIPTION"; via: Via; at: string; scheduledFor: string | null; title: string; detail: string; status: string; reference: string; fileId: string | null }
interface ActivityEvent extends JourneyEvent { patient: { id: string; name: string; mrn: string | null } }

const VIA: Record<Via, { label: string; tone: "blue" | "green" | "amber" | "gray" }> = {
  VOICEBOT: { label: "Voicebot", tone: "blue" }, OCR: { label: "OCR scan", tone: "green" }, PHONE_BOT: { label: "Phone bot", tone: "amber" }, STAFF: { label: "Staff", tone: "gray" },
};
const KIND_ICON: Record<JourneyEvent["kind"], string> = { APPOINTMENT: "🩺", LAB_BOOKING: "🧪", PRESCRIPTION: "📄" };

function when(iso: string, tz: string): string { return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso)); }

function Row({ e, tz, patient }: { e: JourneyEvent; tz: string; patient?: ActivityEvent["patient"] }) {
  const via = VIA[e.via];
  return (
    <li className="flex gap-3 border-b border-slate-100 py-2 last:border-0">
      <span aria-hidden className="text-lg leading-6">{KIND_ICON[e.kind]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {patient && <Link href={`/patients/${patient.id}`} className="text-sm font-semibold text-brand-700 hover:underline">{patient.name}{patient.mrn ? ` · ${patient.mrn}` : ""}</Link>}
          <span className="text-sm font-medium text-slate-900">{e.title}</span>
          <Badge tone={via.tone}>{via.label}</Badge>
          {e.fileId && e.kind !== "PRESCRIPTION" && <Badge tone="gray">from scanned prescription</Badge>}
          <StatusBadge value={e.status} />
        </div>
        <div className="text-xs text-slate-500">
          {e.detail && <>{e.detail} · </>}{e.scheduledFor ? <>for {when(e.scheduledFor, tz)} · </> : null}recorded {when(e.at, tz)} · ref {e.reference}
        </div>
      </div>
    </li>
  );
}

/** One patient, one story: voicebot bookings, scanned prescriptions and the tests and visits they led to, newest first. Refreshes by itself. */
export function JourneyCard({ patientId }: { patientId: string }) {
  const { me } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const q = useQuery({ queryKey: ["journey", patientId], queryFn: () => api.get<{ events: JourneyEvent[] }>(`/frontdesk/journey/${patientId}`), refetchInterval: 10_000 });
  return (
    <Card title="Patient journey">
      {q.isLoading ? <Spinner /> : q.data?.events.length === 0 ? <p className="text-sm text-slate-500">No bookings or prescriptions yet. Bookings made by the voicebot and scanned prescriptions appear here as they happen.</p> : (
        <ul>{q.data?.events.map((e) => <Row key={`${e.kind}-${e.id}`} e={e} tz={tz} />)}</ul>
      )}
    </Card>
  );
}

/** The latest bookings and scans made by the voicebot and OCR apps, across patients. Refreshes by itself. */
export function AppsActivityCard() {
  const { me } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const q = useQuery({ queryKey: ["apps-activity"], queryFn: () => api.get<ActivityEvent[]>("/frontdesk/activity", { limit: 12 }), refetchInterval: 8_000 });
  return (
    <Card title="Voicebot and OCR activity" className="mt-4">
      {q.isLoading ? <Spinner /> : q.data?.length === 0 ? <p className="text-sm text-slate-500">Nothing yet. Bookings made through the voicebot app and prescriptions read by the OCR app show up here within seconds.</p> : (
        <ul>{q.data?.map((e) => <Row key={`${e.kind}-${e.id}`} e={e} tz={tz} patient={e.patient} />)}</ul>
      )}
    </Card>
  );
}
