"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PatientPicker, type PickedPatient } from "@/components/pickers";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, Spinner, Table, Td, useDebounced } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

/** What the server says is connected. Voice, spoken replies and prescription reading all run on the remote AI host (a Kaggle notebook), never in this browser or on this computer. */
interface Capabilities { voice: boolean; speaking: boolean; prescriptionReading: boolean; model: boolean }
function useCapabilities() {
  return useQuery({ queryKey: ["assistant-capabilities"], queryFn: () => api.get<Capabilities>("/assistant/capabilities"), staleTime: 30_000 });
}

/** Posts a body the shared client cannot carry (a recording or a picture) through the same-origin gateway. */
async function postBinary<T>(path: string, body: Blob | File, type: string): Promise<T> {
  const res = await fetch(`/api/proxy${path}`, { method: "POST", headers: { "content-type": type, "x-medos-csrf": "1" }, body, credentials: "same-origin" });
  if (res.status === 401) window.location.assign("/login");
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string; details?: unknown } };
  if (!res.ok || json.data === undefined) throw new ApiError(res.status, json.error?.code ?? "ERROR", json.error?.message ?? "Something went wrong", json.error?.details);
  return json.data;
}

// ───── talk or type ─────

type SpeechLang = "hi" | "en";
interface Turn {
  sessionId: string; reply: string; lang: SpeechLang; awaiting: string | null; engine: "model" | "rules";
  booked: { type: "DOCTOR" | "LAB"; id: string; reference: string } | null;
  understood: { tests: string[]; doctor: string | null; department: string | null; date: string | null; time: string | null; patient: string | null };
}
interface Msg { who: "you" | "assistant"; text: string; booked?: Turn["booked"] }

const MAX_RECORD_MS = 20_000;
const MIN_CLIP_BYTES = 1200;
const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

const EXAMPLES: Record<SpeechLang, string[]> = {
  hi: ["CBC जांच का रेट क्या है?", "कल सुबह कार्डियोलॉजी के डॉक्टर से अपॉइंटमेंट चाहिए", "शुगर और थायराइड टेस्ट बुक करना है"],
  en: ["What is the rate of a lipid profile?", "Book an appointment with a cardiologist tomorrow morning", "Book CBC and thyroid tests tomorrow"],
};

export function TalkPanel() {
  const t = useT();
  const qc = useQueryClient();
  const caps = useCapabilities();
  const [lang, setLang] = useState<SpeechLang>("hi");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [speak, setSpeak] = useState(true);
  const [heard, setHeard] = useState<Turn["understood"] | null>(null);
  const session = useRef<string | null>(null);
  /** What the assistant last asked for, so the speech service knows to expect a name, an age, a phone number or a yes/no. */
  const awaiting = useRef<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const canRecord = typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [msgs, busy, hearing]);
  useEffect(() => () => { if (recorder.current?.state === "recording") recorder.current.stop(); player.current?.pause(); }, []);

  /** The reply is spoken by the AI host; the audio comes back as a file and is played here. If it cannot be, the text is still on screen. */
  const playReply = async (text: string, l: SpeechLang) => {
    if (!speak || !caps.data?.speaking) return;
    try {
      const res = await fetch("/api/proxy/assistant/speak", { method: "POST", headers: { "content-type": "application/json", "x-medos-csrf": "1" }, body: JSON.stringify({ text: text.slice(0, 500), lang: l }), credentials: "same-origin" });
      if (!res.ok) { setVoiceNote("The reply could not be spoken just now. It is shown above."); return; }
      const url = URL.createObjectURL(await res.blob());
      player.current?.pause();
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      player.current = a;
      await a.play();
    } catch { setVoiceNote("The reply could not be played. It is shown above."); }
  };

  const send = async (text: string) => {
    const said = text.trim();
    if (!said) return;
    setMsgs((m) => [...m, { who: "you", text: said }]);
    setDraft(""); setBusy(true); setError(null);
    try {
      const r = await api.post<Turn>("/assistant/turn", { text: said, lang, ...(session.current ? { sessionId: session.current } : {}) });
      session.current = r.sessionId;
      awaiting.current = r.awaiting;
      setHeard(r.understood);
      setMsgs((m) => [...m, { who: "assistant", text: r.reply, ...(r.booked ? { booked: r.booked } : {}) }]);
      if (r.booked) { void qc.invalidateQueries({ queryKey: ["appointments"] }); void qc.invalidateQueries({ queryKey: ["lab-bookings"] }); }
      void playReply(r.reply, r.lang);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  /** The clip goes to MedOS, which sends it to the AI host to be turned into words; the words are then treated exactly like typed ones. */
  const transcribe = async (clip: Blob) => {
    setHearing(true); setError(null);
    try {
      const out = await postBinary<{ text: string }>(`/assistant/transcribe?lang=${lang}&hint=${["name", "age", "mobile", "confirm"].includes(awaiting.current ?? "") ? awaiting.current : "open"}`, clip, clip.type || "audio/webm");
      if (!out.text.trim()) { setVoiceNote("Nothing was heard. Press the microphone and try again."); return; }
      await send(out.text);
    } catch (e) { setError(e); } finally { setHearing(false); }
  };

  const toggleRecording = async () => {
    if (recorder.current?.state === "recording") { recorder.current.stop(); return; }
    setVoiceNote(null);
    player.current?.pause();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = RECORDER_TYPES.find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) parts.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const clip = new Blob(parts, { type: rec.mimeType || mime || "audio/webm" });
        if (clip.size >= MIN_CLIP_BYTES) void transcribe(clip); else setVoiceNote("Nothing was heard. Press the microphone and try again.");
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      window.setTimeout(() => { if (rec.state === "recording") rec.stop(); }, MAX_RECORD_MS);
    } catch { setVoiceNote("The microphone was blocked or is missing. Allow it in the browser, or type instead."); }
  };

  const newChat = () => { session.current = null; awaiting.current = null; setMsgs([]); setHeard(null); setError(null); setDraft(""); player.current?.pause(); };
  const chips = heard ? [...heard.tests, heard.doctor, heard.department, heard.date, heard.time, heard.patient].filter((x): x is string => !!x) : [];
  const micReady = !!caps.data?.voice && canRecord;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <Card
        title="Conversation"
        actions={<>
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm" role="group" aria-label={t("Language")}>
            {(["hi", "en"] as const).map((l) => (
              <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)} className={`px-2.5 py-1 ${lang === l ? "bg-brand-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}>{l === "hi" ? "हिन्दी" : "English"}</button>
            ))}
          </div>
          <Button variant="ghost" onClick={newChat}>New conversation</Button>
        </>}
      >
        <div className="mb-3 h-80 space-y-2 overflow-y-auto rounded-md bg-slate-50 p-3" aria-live="polite">
          {msgs.length === 0 && (
            <div className="space-y-2 text-sm text-slate-500">
              <p>{t("Speak or type in Hindi or English. Ask a lab test rate, find a doctor, or book a test or an appointment.")}</p>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES[lang].map((x) => <button key={x} type="button" onClick={() => void send(x)} className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-left text-slate-700 hover:bg-brand-50">{x}</button>)}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={m.who === "you" ? "flex justify-end" : "flex justify-start"}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.who === "you" ? "bg-brand-600 text-white" : "border border-slate-200 bg-white text-slate-900"}`}>
                <p className="whitespace-pre-wrap">{m.text}</p>
                {m.booked && (
                  <p className="mt-1.5 text-xs">
                    <Badge tone="green">{m.booked.type === "LAB" ? "Lab test booked" : "Appointment booked"}</Badge>{" "}
                    <span className="font-mono">{m.booked.reference}</span>{" · "}
                    {m.booked.type === "DOCTOR" ? <Link className="text-brand-700 underline" href="/appointments">{t("Appointments")}</Link> : <span>{t("See it under Lab rates and bookings")}</span>}
                  </p>
                )}
              </div>
            </div>
          ))}
          {hearing && <p className="text-sm text-slate-500">{t("Listening to the recording…")}</p>}
          {busy && <p className="text-sm text-slate-500">{t("Thinking…")}</p>}
          <div ref={end} />
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
          {micReady && (
            <Button variant={recording ? "danger" : "secondary"} disabled={hearing || busy} onClick={() => void toggleRecording()} aria-label={t(recording ? "Stop and send" : "Speak")} aria-pressed={recording}>
              {recording ? "■ Stop and send" : "🎤 Speak"}
            </Button>
          )}
          <Input aria-label={t("Message")} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={lang === "hi" ? "यहाँ लिखें…" : "Type here…"} lang={lang} disabled={busy || hearing} />
          <Button disabled={!draft.trim() || busy || hearing} onClick={() => void send(draft)}>Send</Button>
        </form>
        <div className="mt-2 space-y-2">
          <ErrorNote error={error} />
          {voiceNote && <Notice tone="warn">{voiceNote}</Notice>}
          {caps.isSuccess && !caps.data.voice && <Notice tone="warn">Voice is not connected: the AI service has not been set up for this MedOS. You can still type.</Notice>}
          {caps.isSuccess && caps.data.voice && !canRecord && <Notice tone="warn">This browser cannot record. Use a current Chrome, Edge or Firefox, or type.</Notice>}
          <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={speak} disabled={!caps.data?.speaking} onChange={(e) => setSpeak(e.target.checked)} />{t("Read replies aloud")}</label>
          <p className="text-xs text-slate-500">{t("Your voice clip is sent to the AI service to be turned into words, and replies are spoken by it. Neither is kept. Type instead if a caller's details should not leave this computer.")}</p>
        </div>
      </Card>
      <Card title="What I understood">
        {chips.length === 0 ? <p className="text-sm text-slate-500">{t("Nothing yet.")}</p> : <div className="flex flex-wrap gap-1.5">{chips.map((c, i) => <Badge key={`${c}-${i}`} tone="blue">{c}</Badge>)}</div>}
        <p className="mt-3 text-xs text-slate-500">{t("Rates, doctors and free times always come from MedOS records. Nothing is booked until you say yes to the read-back.")}</p>
        {caps.isSuccess && !caps.data.model && <p className="mt-3 text-xs text-amber-700">{t("No language model is connected, so only simple wording is understood.")}</p>}
      </Card>
    </div>
  );
}

// ───── scan a prescription ─────

interface ScanResult {
  reading: { engine: string; confidence: number; unclear: boolean; text: string };
  tests: { testId: string; name: string; price: string; matched: string; confidence: "HIGH" | "MEDIUM"; reason: string }[];
  visits: { kind: "FOLLOW_UP" | "REFERRAL"; doctorName: string | null; departmentFragment: string | null; afterDays: number; confidence: "HIGH" | "MEDIUM"; evidence: string; why: string; booked: boolean }[];
  booked: { lab: { id: string; reference: string; total: string; collectionAt: string; tests: string[] } | null; appointments: { id: string; reference: string; doctor: string; startAt: string }[] };
  needsReview: { what: string; reason: string }[];
  fileId: string | null; autoBook: boolean;
}
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "application/pdf"];

export function ScanPanel() {
  const t = useT();
  const qc = useQueryClient();
  const caps = useCapabilities();
  const { money, dateTime, can } = useMe();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const willBook = auto && !!patient;

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const scan = useMutation({
    mutationFn: () => {
      const f = file as File;
      const q = new URLSearchParams({ autoBook: String(willBook), filename: f.name.slice(0, 120) });
      if (patient) q.set("patientId", patient.id);
      return postBinary<ScanResult>(`/assistant/prescription-scan?${q}`, f, f.type);
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["appointments"] }); await qc.invalidateQueries({ queryKey: ["lab-bookings"] }); },
  });

  const pick = (f: File | undefined) => {
    scan.reset();
    setFileNote(null);
    if (!f) { setFile(null); return; }
    if (!ACCEPT.includes(f.type)) { setFile(null); setFileNote("Choose a PNG, JPEG or PDF file."); return; }
    if (f.size > MAX_BYTES) { setFile(null); setFileNote("The file is larger than 5 MB."); return; }
    setFile(f);
  };
  const r = scan.data;

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <Card title="Prescription">
        <div className="space-y-3">
          {caps.isSuccess && !caps.data.prescriptionReading && <Notice tone="warn">Reading prescriptions is not connected: the AI service has not been set up for this MedOS. Book by hand for now.</Notice>}
          <Field as="div" label="Patient" hint="Needed to book. Without a patient the prescription is only read."><PatientPicker value={patient} onPick={setPatient} /></Field>
          <Field label="Prescription file (PNG, JPEG or PDF, up to 5 MB)">
            <input type="file" accept={ACCEPT.join(",")} onChange={(e) => pick(e.target.files?.[0])} className="text-sm file:mr-2 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-2 file:py-1" />
          </Field>
          {fileNote && <Notice tone="warn">{fileNote}</Notice>}
          {preview && <img src={preview} alt={t("Prescription preview")} className="max-h-56 rounded-md border border-slate-200 object-contain" />}
          <label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" className="mt-0.5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{t("Book automatically what is certain (lab tests and follow-up visit). Anything unsure is listed for you to check.")}</label>
          <ErrorNote error={scan.error} />
          <Button disabled={!file || caps.data?.prescriptionReading === false} loading={scan.isPending} onClick={() => scan.mutate()}>{willBook ? "Read and book" : "Read only"}</Button>
          <p className="text-xs text-slate-500">{t("The picture is sent to the AI service to be read and is not read on this computer. Printed prescriptions read well; handwriting does not, so unclear ones are never booked.")}</p>
        </div>
      </Card>

      <div className="space-y-4">
        {!r && !scan.isPending && <Card><p className="text-sm text-slate-500">{t("Choose a prescription to see the tests and visits found in it.")}</p></Card>}
        {scan.isPending && <Card><Spinner /></Card>}
        {r && (
          <>
            {r.booked.lab || r.booked.appointments.length > 0 ? (
              <Notice tone="success">
                <div className="space-y-1">
                  {r.booked.lab && <p>{t("Lab tests booked")}: <span className="font-mono">{r.booked.lab.reference}</span> · {r.booked.lab.tests.join(", ")} · {money(r.booked.lab.total)} · {dateTime(r.booked.lab.collectionAt)}</p>}
                  {r.booked.appointments.map((a) => <p key={a.id}>{t("Appointment booked")}: <span className="font-mono">{a.reference}</span> · {a.doctor} · {dateTime(a.startAt)} · <Link className="underline" href="/appointments">{t("Appointments")}</Link></p>)}
                </div>
              </Notice>
            ) : r.autoBook ? <Notice tone="warn">Nothing was booked automatically. See the items to check below.</Notice> : null}
            {r.needsReview.length > 0 && (
              <Card title="Please check these">
                <ul className="space-y-2 text-sm">{r.needsReview.map((n, i) => <li key={i}><span className="font-medium">{n.what}</span><span className="text-slate-600"> — {n.reason}</span></li>)}</ul>
              </Card>
            )}
            <Card title="Lab tests found">
              {r.tests.length === 0 ? <p className="text-sm text-slate-500">{t("No lab test from the hospital's list was found in this prescription.")}</p> : (
                <Table head={["Test", "Read as", "Rate", "Match"]}>
                  {r.tests.map((x) => (
                    <tr key={x.testId}><Td className="font-medium">{x.name}</Td><Td className="text-slate-600">{x.matched}</Td><Td>{money(x.price)}</Td><Td><Badge tone={x.confidence === "HIGH" ? "green" : "amber"}>{x.confidence === "HIGH" ? "Certain" : "Check"}</Badge></Td></tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="Follow-up or referral found">
              {r.visits.length === 0 ? <p className="text-sm text-slate-500">{t("No follow-up visit or referral was found.")}</p> : (
                <ul className="space-y-2 text-sm">
                  {r.visits.map((v, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <Badge tone={v.booked ? "green" : v.confidence === "HIGH" ? "blue" : "amber"}>{v.booked ? "Booked" : v.confidence === "HIGH" ? "Certain" : "Check"}</Badge>
                      <span className="font-medium">{v.doctorName ?? v.departmentFragment ?? "—"}</span>
                      <span className="text-slate-600">“{v.evidence}”</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="What was read" actions={<Badge tone={r.reading.unclear ? "red" : r.reading.confidence >= 80 ? "green" : "amber"}>{`${r.reading.confidence}% ${t("clear")}`}</Badge>}>
              <details>
                <summary className="cursor-pointer text-sm text-brand-700">{t("Show the text the reader found")}</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs text-slate-700">{r.reading.text || "—"}</pre>
              </details>
              {can("PATIENT_READ") && r.fileId && <p className="mt-2 text-xs text-slate-500">{t("The scan was also saved to the patient's documents.")}</p>}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

// ───── lab rates and bookings ─────

interface LabTest { id: string; code: string; name: string; price: string; sampleType: string; reportHours: number; fastingRequired: boolean }
interface LabBooking { id: string; status: string; source: "MANUAL" | "VOICE_ASSISTANT" | "PRESCRIPTION"; collectionAt: string; homeCollection: boolean; totalAmount: string; patientName: string; mrn: string | null; items: { name: string }[] }
const SOURCE_LABEL: Record<LabBooking["source"], string> = { MANUAL: "Reception", VOICE_ASSISTANT: "Assistant", PRESCRIPTION: "Prescription" };

export function LabPanel() {
  const t = useT();
  const { money, dateTime } = useMe();
  const [q, setQ] = useState("");
  const search = useDebounced(q.trim());
  const tests = useQuery({ queryKey: ["lab-tests", search], queryFn: () => api.page<LabTest>("/lab/tests", { ...(search ? { q: search } : {}), pageSize: 100 }) });
  const bookings = useQuery({ queryKey: ["lab-bookings"], queryFn: () => api.page<LabBooking>("/lab/bookings", { status: "BOOKED", pageSize: 50 }) });
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Lab test rates" actions={<Input aria-label={t("Search tests")} placeholder="Search tests…" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" />}>
        {tests.isLoading ? <Spinner /> : (
          <Table head={["Test", "Rate", "Report in", "Fasting"]} {...(tests.data?.data.length === 0 ? { empty: "No test matches." } : {})}>
            {tests.data?.data.map((x) => <tr key={x.id}><Td><span className="font-medium">{x.name}</span> <span className="text-slate-500">· {x.code}</span></Td><Td>{money(x.price)}</Td><Td>{x.reportHours} h</Td><Td>{x.fastingRequired ? t("Yes") : t("No")}</Td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Upcoming lab bookings">
        {bookings.isLoading ? <Spinner /> : (
          <Table head={["Collection", "Patient", "Tests", "Total", "Booked from"]} {...(bookings.data?.data.length === 0 ? { empty: "No lab bookings yet." } : {})}>
            {bookings.data?.data.map((b) => (
              <tr key={b.id}>
                <Td>{dateTime(b.collectionAt)}{b.homeCollection && <div className="text-xs text-slate-500">{t("Home collection")}</div>}</Td>
                <Td><span className="font-medium">{b.patientName}</span> <span className="text-slate-500">· {b.mrn}</span></Td>
                <Td className="text-slate-700">{b.items.map((i) => i.name).join(", ")}</Td>
                <Td>{money(b.totalAmount)}</Td>
                <Td><Badge tone={b.source === "MANUAL" ? "gray" : "purple"}>{SOURCE_LABEL[b.source]}</Badge></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
