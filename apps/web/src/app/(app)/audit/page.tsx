"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Button, Card, ErrorNote, Input, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Event { id: string; action: string; entityType: string; entityId: string | null; actorUserId: string | null; requestId: string | null; createdAt: string; metadata: Record<string, unknown> }

export default function AuditPage() {
  const { dateTime } = useMe();
  const [action, setAction] = useState("");
  const [entityId, setEntityId] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ["audit", action, entityId, page], queryFn: () => api.page<Event>("/audit-events", { ...(action ? { action: action.toUpperCase() } : {}), ...(entityId ? { entityId } : {}), page, pageSize: 50 }) });
  const total = list.data?.meta.total ?? 0;
  return (
    <Gate anyOf={["AUDIT_READ"]}>
      <PageHeader title="Audit trail" subtitle="Who did what, and when. Events cannot be edited or deleted." actions={<>
        <Input placeholder="Action (e.g. PAYMENT_RECEIVED)" aria-label="Action" className="w-60" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />
        <Input placeholder="Record id" aria-label="Record id" className="w-72" value={entityId} onChange={(e) => { setEntityId(e.target.value); setPage(1); }} />
      </>} />
      <Card>
        {list.isLoading ? <Spinner /> : <>
          <ErrorNote error={list.error} />
          <Table head={["When", "Action", "Record", "Actor", "Details"]} {...(list.data?.data.length === 0 ? { empty: "No events match." } : {})}>
            {list.data?.data.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap">{dateTime(e.createdAt)}</Td><Td><code className="text-xs">{e.action}</code></Td>
                <Td>{e.entityType}<div className="max-w-[12rem] truncate text-xs text-slate-500">{e.entityId}</div></Td>
                <Td><span className="text-xs text-slate-500">{e.actorUserId?.slice(0, 8) ?? "system"}</span></Td>
                <Td><span className="text-xs text-slate-600">{Object.entries(e.metadata ?? {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ")}</span></Td>
              </tr>
            ))}
          </Table>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-500"><span>{total} events</span><span className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="secondary" disabled={page * 50 >= total} onClick={() => setPage(page + 1)}>Next</Button></span></div>
        </>}
      </Card>
    </Gate>
  );
}
