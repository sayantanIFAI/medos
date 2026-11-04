"use client";
import { useState } from "react";
import { Gate } from "@/components/gate";
import { LabPanel, ScanPanel, TalkPanel } from "@/components/assistant-panels";
import { PageHeader, Tabs } from "@/components/ui";
import { useMe } from "@/lib/me";

type Tab = "talk" | "scan" | "lab";

export default function AssistantPage() {
  const { can } = useMe();
  const [tab, setTab] = useState<Tab>("talk");
  const tabs: { id: Tab; label: string }[] = [
    { id: "talk", label: "Speak or type" },
    ...(can("PATIENT_READ") ? [{ id: "scan" as const, label: "Scan a prescription" }] : []),
    ...(can("LAB_READ") ? [{ id: "lab" as const, label: "Lab rates and bookings" }] : []),
  ];
  return (
    <Gate anyOf={["ASSISTANT_USE"]}>
      <PageHeader title="Assistant" subtitle="Ask in Hindi or English. Lab rates, doctor times and bookings go straight into MedOS." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "talk" && <TalkPanel />}
      {tab === "scan" && <ScanPanel />}
      {tab === "lab" && <LabPanel />}
    </Gate>
  );
}
