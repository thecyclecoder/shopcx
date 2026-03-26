"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Workflow {
  id: string;
  name: string;
  template: string;
  trigger_tag: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

const TEMPLATES = [
  {
    id: "order_tracking",
    name: "Order Tracking",
    description: "Auto-respond to 'where is my order' inquiries with real-time tracking data from Shopify.",
    trigger: "smart:order-tracking",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
  },
  {
    id: "cancel_request",
    name: "Cancel Request",
    description: "Handle subscription cancellation requests — confirm receipt, optionally auto-cancel via Appstle, escalate to agent.",
    trigger: "smart:cancel-request",
    icon: "M6 18L18 6M6 6l12 12",
  },
  {
    id: "subscription_inquiry",
    name: "Subscription Inquiry",
    description: "Auto-respond to subscription questions with next billing date, items, and frequency info.",
    trigger: "smart:subscription",
    icon: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
  },
];

// Config field definitions per template
const TEMPLATE_FIELDS: Record<string, { section: string; fields: { key: string; label: string; type: "text" | "textarea" | "number" | "boolean" | "select"; hint?: string; options?: { value: string; label: string }[] }[] }[]> = {
  order_tracking: [
    {
      section: "Delay Threshold",
      fields: [
        { key: "delay_threshold_days", label: "Days before escalating", type: "number", hint: "If order shipped more than this many days ago, escalate to agent" },
      ],
    },
    {
      section: "Auto-Reply Templates",
      fields: [
        { key: "reply_preparing", label: "Order being prepared (unfulfilled)", type: "textarea", hint: "{{customer.first_name}}, {{order.order_number}}" },
        { key: "reply_no_tracking", label: "Shipped, no tracking yet", type: "textarea" },
        { key: "reply_in_transit", label: "In transit (within threshold)", type: "textarea", hint: "{{fulfillment.date}}, {{fulfillment.carrier}}, {{fulfillment.url}}, {{fulfillment.latest_location}}, {{fulfillment.estimated_delivery}}" },
        { key: "reply_out_for_delivery", label: "Out for delivery", type: "textarea", hint: "{{fulfillment.latest_location}}" },
        { key: "reply_delivered", label: "Marked as delivered", type: "textarea", hint: "{{fulfillment.delivered_at}}" },
        { key: "reply_no_order", label: "No order found", type: "textarea" },
      ],
    },
    {
      section: "Escalation (delayed orders)",
      fields: [
        { key: "escalate_delayed", label: "Enable escalation for delayed orders", type: "boolean" },
        { key: "reply_escalated", label: "Customer reply on escalation", type: "textarea", hint: "Sent to customer when order is delayed. Leave empty to skip customer reply." },
        { key: "escalate_to", label: "Escalate to (team member)", type: "select", options: [] },
        { key: "escalate_tag", label: "Escalation tag", type: "text" },
        { key: "escalate_status", label: "Ticket status after escalation (if no reply sent)", type: "select", options: [{ value: "open", label: "Open" }, { value: "pending", label: "Pending" }, { value: "closed", label: "Closed" }] },
      ],
    },
  ],
  cancel_request: [
    {
      section: "Auto-Reply Templates",
      fields: [
        { key: "reply_no_subscription", label: "No subscription found", type: "textarea" },
        { key: "reply_confirm_cancel", label: "Cancellation received", type: "textarea" },
      ],
    },
    {
      section: "Automation",
      fields: [
        { key: "auto_cancel_via_appstle", label: "Auto-cancel subscription via Appstle API", type: "boolean" },
        { key: "escalate_to_agent", label: "Escalate to agent", type: "boolean" },
        { key: "escalate_tag", label: "Escalation tag", type: "text" },
      ],
    },
  ],
  subscription_inquiry: [
    {
      section: "Auto-Reply Templates",
      fields: [
        { key: "reply_next_date", label: "Next shipment date reply", type: "textarea", hint: "{{subscription.next_billing_date}}, {{subscription.items}}" },
        { key: "reply_no_subscription", label: "No subscription found", type: "textarea" },
      ],
    },
  ],
};

export default function WorkflowsPage() {
  const workspace = useWorkspace();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<{ user_id: string; display_name: string | null; email: string | null }[]>([]);

  if (!["owner", "admin"].includes(workspace.role)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/workflows`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setWorkflows(d); })
      .finally(() => setLoading(false));
    fetch(`/api/workspaces/${workspace.id}/members`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setMembers(d); })
      .catch(() => {});
  }, [workspace.id]);

  const handleCreate = async (templateId: string) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: templateId }),
    });
    if (res.ok) {
      const wf = await res.json();
      setWorkflows(prev => [...prev, wf]);
      setEditing(wf);
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/workflows/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editing.name, enabled: editing.enabled, config: editing.config }),
    });
    if (res.ok) {
      const saved = await res.json();
      setWorkflows(prev => prev.map(w => w.id === saved.id ? saved : w));
      setEditing(null);
    }
    setSaving(false);
  };

  const handleToggle = async (wf: Workflow) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/workflows/${wf.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !wf.enabled }),
    });
    if (res.ok) {
      setWorkflows(prev => prev.map(w => w.id === wf.id ? { ...w, enabled: !w.enabled } : w));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this workflow?")) return;
    await fetch(`/api/workspaces/${workspace.id}/workflows/${id}`, { method: "DELETE" });
    setWorkflows(prev => prev.filter(w => w.id !== id));
  };

  const existingTemplates = new Set(workflows.map(w => w.template));

  if (loading) return <div className="p-8 text-sm text-zinc-400">Loading...</div>;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Workflows</h1>
      <p className="mt-1 text-sm text-zinc-500">Automated multi-step responses triggered by smart tags.</p>

      {/* Existing workflows */}
      {!editing && workflows.length > 0 && (
        <div className="mt-6 space-y-2">
          {workflows.map(wf => {
            const tpl = TEMPLATES.find(t => t.id === wf.template);
            return (
              <div key={wf.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{wf.name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${wf.enabled ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"}`}>
                      {wf.enabled ? "Active" : "Disabled"}
                    </span>
                    <span className="rounded bg-violet-50 px-1.5 py-0.5 text-sm text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">{wf.trigger_tag}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-zinc-400">{tpl?.description}</p>
                </div>
                <div className="ml-4 flex items-center gap-2">
                  <button onClick={() => handleToggle(wf)} className="text-sm text-zinc-400 hover:text-zinc-600">{wf.enabled ? "Disable" : "Enable"}</button>
                  <button onClick={() => setEditing(wf)} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">Configure</button>
                  <button onClick={() => handleDelete(wf.id)} className="text-sm text-red-500 hover:underline">Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Template gallery */}
      {!editing && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {workflows.length > 0 ? "Add Another Workflow" : "Available Templates"}
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            {TEMPLATES.filter(t => !existingTemplates.has(t.id)).map(tpl => (
              <div key={tpl.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center gap-2">
                  <svg className="h-5 w-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={tpl.icon} />
                  </svg>
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{tpl.name}</h3>
                </div>
                <p className="mt-2 text-sm text-zinc-500">{tpl.description}</p>
                <p className="mt-1 text-sm text-violet-500">Trigger: {tpl.trigger}</p>
                <button
                  onClick={() => handleCreate(tpl.id)}
                  className="mt-3 w-full rounded-md bg-indigo-600 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  Set Up
                </button>
              </div>
            ))}
            {TEMPLATES.filter(t => !existingTemplates.has(t.id)).length === 0 && (
              <p className="col-span-3 text-center text-sm text-zinc-400">All templates are in use.</p>
            )}
          </div>
        </div>
      )}

      {/* Config editor */}
      {editing && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Configure: {editing.name}</h2>
            <label className="flex items-center gap-1.5 text-sm text-zinc-500">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                className="h-3 w-3 rounded border-zinc-300 text-emerald-600"
              />
              Enabled
            </label>
          </div>

          {/* Visual step flow */}
          <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
            <p className="text-sm font-medium text-zinc-500">Workflow Steps</p>
            {editing.template === "order_tracking" && (
              <div className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                <p>1. Find customer&apos;s most recent order</p>
                <p className="ml-4">If unfulfilled &rarr; Reply with preparing message</p>
                <p className="ml-4">If fulfilled, no tracking &rarr; Reply with shipped message</p>
                <p className="ml-4">If out for delivery &rarr; Reply with location</p>
                <p className="ml-4">If delivered &rarr; Reply with delivery date</p>
                <p className="ml-4">If in transit &gt; <strong>{(editing.config.delay_threshold_days as number) || 10}</strong> days &rarr; {editing.config.reply_escalated ? "Reply + " : ""}Escalate{editing.config.escalate_to ? ` to ${members.find(m => m.user_id === editing.config.escalate_to)?.display_name || "agent"}` : ""}</p>
                <p className="ml-4">If in transit &le; {(editing.config.delay_threshold_days as number) || 10} days &rarr; Reply with tracking + location</p>
              </div>
            )}
            {editing.template === "cancel_request" && (
              <div className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                <p>1. Look up customer&apos;s active subscription</p>
                <p className="ml-4">If no subscription &rarr; Reply asking for details</p>
                <p className="ml-4">If active subscription &rarr; Confirm receipt</p>
                {!!editing.config.auto_cancel_via_appstle && <p className="ml-4">Auto-cancel via Appstle API</p>}
                {editing.config.escalate_to_agent !== false && <p className="ml-4">Escalate to agent</p>}
              </div>
            )}
            {editing.template === "subscription_inquiry" && (
              <div className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                <p>1. Look up customer&apos;s active subscription</p>
                <p className="ml-4">If no subscription &rarr; Reply asking for details</p>
                <p className="ml-4">If active &rarr; Reply with next billing date + items</p>
              </div>
            )}
          </div>

          {/* Variable reference */}
          <details className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-zinc-500">Available Variables (click to expand)</summary>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 px-3 pb-3 text-sm">
              <div className="font-medium text-zinc-600 dark:text-zinc-300 mt-1">Customer</div><div />
              <div className="text-zinc-500">{`{{customer.first_name}}`}</div><div className="text-zinc-400">First name or &ldquo;there&rdquo;</div>
              <div className="text-zinc-500">{`{{customer.last_name}}`}</div><div className="text-zinc-400">Last name</div>
              <div className="text-zinc-500">{`{{customer.email}}`}</div><div className="text-zinc-400">Email address</div>
              <div className="text-zinc-500">{`{{customer.phone}}`}</div><div className="text-zinc-400">Phone number</div>
              <div className="font-medium text-zinc-600 dark:text-zinc-300 mt-1">Order</div><div />
              <div className="text-zinc-500">{`{{order.order_number}}`}</div><div className="text-zinc-400">e.g. SC125993</div>
              <div className="text-zinc-500">{`{{order.total}}`}</div><div className="text-zinc-400">e.g. $89.95</div>
              <div className="text-zinc-500">{`{{order.created_at}}`}</div><div className="text-zinc-400">Order date</div>
              <div className="text-zinc-500">{`{{order.line_items}}`}</div><div className="text-zinc-400">e.g. 2x Coffee, 1x Creamer</div>
              <div className="font-medium text-zinc-600 dark:text-zinc-300 mt-1">Fulfillment</div><div />
              <div className="text-zinc-500">{`{{fulfillment.date}}`}</div><div className="text-zinc-400">Ship date</div>
              <div className="text-zinc-500">{`{{fulfillment.carrier}}`}</div><div className="text-zinc-400">e.g. USPS, DHL</div>
              <div className="text-zinc-500">{`{{fulfillment.tracking_number}}`}</div><div className="text-zinc-400">Tracking number</div>
              <div className="text-zinc-500">{`{{fulfillment.url}}`}</div><div className="text-zinc-400">Tracking URL</div>
              <div className="text-zinc-500">{`{{fulfillment.status}}`}</div><div className="text-zinc-400">e.g. DELIVERED, IN_TRANSIT</div>
              <div className="text-zinc-500">{`{{fulfillment.delivered_at}}`}</div><div className="text-zinc-400">Delivery date</div>
              <div className="text-zinc-500">{`{{fulfillment.estimated_delivery}}`}</div><div className="text-zinc-400">Estimated delivery</div>
              <div className="text-zinc-500">{`{{fulfillment.latest_location}}`}</div><div className="text-zinc-400">e.g. Austin, TX</div>
              <div className="text-zinc-500">{`{{fulfillment.delivery_address}}`}</div><div className="text-zinc-400">Ship-to address from order</div>
              <div className="text-zinc-500">{`{{fulfillment.days_since}}`}</div><div className="text-zinc-400">Days since shipment</div>
              <div className="font-medium text-zinc-600 dark:text-zinc-300 mt-1">Subscription</div><div />
              <div className="text-zinc-500">{`{{subscription.next_billing_date}}`}</div><div className="text-zinc-400">e.g. April 20, 2026</div>
              <div className="text-zinc-500">{`{{subscription.status}}`}</div><div className="text-zinc-400">active, paused, cancelled</div>
              <div className="text-zinc-500">{`{{subscription.items}}`}</div><div className="text-zinc-400">Item titles joined</div>
              <div className="text-zinc-500">{`{{subscription.billing_interval}}`}</div><div className="text-zinc-400">e.g. 4 week</div>
            </div>
          </details>

          {/* Config sections */}
          {(TEMPLATE_FIELDS[editing.template] || []).map((section, si) => (
            <div key={si} className="mt-6">
              <h3 className="text-sm font-medium text-zinc-500">{section.section}</h3>
              <div className="mt-2 space-y-3">
                {section.fields.map(field => (
                  <div key={field.key}>
                    <label className="block text-sm text-zinc-600 dark:text-zinc-400">{field.label}</label>
                    {field.type === "textarea" ? (
                      <div>
                        <div className="mt-0.5 flex items-center gap-0.5 border-b border-zinc-200 pb-1 dark:border-zinc-600">
                          {[
                            { cmd: "bold", icon: "B", cls: "font-bold" },
                            { cmd: "italic", icon: "I", cls: "italic" },
                          ].map(({ cmd, icon, cls }) => (
                            <button key={cmd} type="button" onMouseDown={(e) => { e.preventDefault(); document.execCommand(cmd); }}
                              className={`rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 ${cls}`}>{icon}</button>
                          ))}
                          <button type="button" onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList"); }}
                            className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-600">
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                          </button>
                          <button type="button" onMouseDown={(e) => {
                            e.preventDefault();
                            const url = prompt("Enter URL:");
                            if (url) document.execCommand("createLink", false, url);
                          }} className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-600">
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                          </button>
                        </div>
                        <div
                          contentEditable
                          suppressContentEditableWarning
                          dangerouslySetInnerHTML={{ __html: (editing.config[field.key] as string) || "" }}
                          onBlur={(e) => setEditing({ ...editing, config: { ...editing.config, [field.key]: e.currentTarget.innerHTML } })}
                          className="min-h-[60px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                        />
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className="text-sm text-zinc-400">After this reply, set status to:</span>
                          <select
                            value={(editing.config[`${field.key}_status`] as string) || "pending"}
                            onChange={(e) => setEditing({ ...editing, config: { ...editing.config, [`${field.key}_status`]: e.target.value } })}
                            className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-sm dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                          >
                            <option value="pending">Pending</option>
                            <option value="closed">Closed</option>
                            <option value="open">Open</option>
                          </select>
                        </div>
                      </div>
                    ) : field.type === "number" ? (
                      <input
                        type="number"
                        value={(editing.config[field.key] as number) || 0}
                        onChange={(e) => setEditing({ ...editing, config: { ...editing.config, [field.key]: parseInt(e.target.value) || 0 } })}
                        className="mt-0.5 block w-24 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                      />
                    ) : field.type === "boolean" ? (
                      <label className="mt-0.5 flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={!!editing.config[field.key]}
                          onChange={(e) => setEditing({ ...editing, config: { ...editing.config, [field.key]: e.target.checked } })}
                          className="h-3 w-3 rounded border-zinc-300 text-indigo-600"
                        />
                        <span className="text-sm text-zinc-500">Enabled</span>
                      </label>
                    ) : field.type === "select" ? (
                      <select
                        value={(editing.config[field.key] as string) || ""}
                        onChange={(e) => setEditing({ ...editing, config: { ...editing.config, [field.key]: e.target.value || null } })}
                        className="mt-0.5 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                      >
                        <option value="">{field.key.includes("escalate_to") ? "Select team member..." : "Select..."}</option>
                        {field.key.includes("escalate_to")
                          ? members.map(m => <option key={m.user_id} value={m.user_id}>{m.display_name || m.email}</option>)
                          : (field.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)
                        }
                      </select>
                    ) : (
                      <input
                        value={(editing.config[field.key] as string) || ""}
                        onChange={(e) => setEditing({ ...editing, config: { ...editing.config, [field.key]: e.target.value } })}
                        className="mt-0.5 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                      />
                    )}
                    {field.hint && <p className="mt-0.5 text-sm text-zinc-400">Variables: {field.hint}</p>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="mt-6 flex gap-2">
            <button onClick={handleSave} disabled={saving} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {saving ? "Saving..." : "Save"}
            </button>
            <button onClick={() => setEditing(null)} className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
