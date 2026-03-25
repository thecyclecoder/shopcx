"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

// ── Types ──

interface RuleCondition {
  field: string;
  op: string;
  value: string;
}

interface ConditionGroup {
  operator: "AND" | "OR";
  conditions: RuleCondition[];
}

interface RuleConditions {
  operator: "AND" | "OR";
  groups: ConditionGroup[];
}

interface RuleAction {
  type: string;
  params: Record<string, string>;
}

interface Rule {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_events: string[];
  conditions: RuleConditions;
  actions: RuleAction[];
  priority: number;
  stop_processing: boolean;
  created_at: string;
}

// ── Constants ──

const TRIGGER_OPTIONS = [
  { value: "ticket.created", label: "Ticket Created" },
  { value: "ticket.message_received", label: "Customer Reply" },
  { value: "ticket.message_sent", label: "Agent Reply" },
  { value: "ticket.status_changed", label: "Ticket Status Changed" },
  { value: "order.created", label: "Order Created" },
  { value: "customer.updated", label: "Customer Updated" },
  { value: "subscription.created", label: "Subscription Created" },
  { value: "subscription.paused", label: "Subscription Paused" },
  { value: "subscription.cancelled", label: "Subscription Cancelled" },
  { value: "subscription.billing-failure", label: "Billing Failed" },
  { value: "subscription.billing-skipped", label: "Billing Skipped" },
  { value: "subscription.billing-success", label: "Billing Succeeded" },
];

const FIELD_OPTIONS = [
  { value: "ticket.subject", label: "Ticket Subject", type: "text" },
  { value: "ticket.status", label: "Ticket Status", type: "select", options: ["open", "pending", "resolved", "closed"] },
  { value: "ticket.channel", label: "Ticket Channel", type: "select", options: ["email", "chat", "meta_dm", "sms"] },
  { value: "ticket.tags", label: "Ticket Tags", type: "array" },
  { value: "message.body", label: "Message Body", type: "text" },
  { value: "message.direction", label: "Message Direction", type: "select", options: ["inbound", "outbound"] },
  { value: "customer.email", label: "Customer Email", type: "text" },
  { value: "customer.subscription_status", label: "Subscription Status", type: "select", options: ["active", "paused", "cancelled", "never"] },
  { value: "customer.retention_score", label: "Retention Score", type: "number" },
  { value: "customer.total_orders", label: "Total Orders", type: "number" },
  { value: "customer.ltv_cents", label: "LTV (cents)", type: "number" },
  { value: "customer.tags", label: "Customer Tags", type: "array" },
  { value: "order.total_cents", label: "Order Total (cents)", type: "number" },
  { value: "order.order_type", label: "Order Type", type: "select", options: ["checkout", "recurring", "replacement"] },
  { value: "order.financial_status", label: "Payment Status", type: "text" },
  { value: "subscription.status", label: "Sub Status", type: "select", options: ["active", "paused", "cancelled", "expired", "failed"] },
  { value: "subscription.last_payment_status", label: "Last Payment", type: "select", options: ["succeeded", "failed", "skipped"] },
];

const OP_OPTIONS = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "starts_with", label: "starts with" },
  { value: "greater_than", label: "greater than" },
  { value: "less_than", label: "less than" },
  { value: "greater_or_equal", label: ">=" },
  { value: "less_or_equal", label: "<=" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
  { value: "array_contains", label: "array contains" },
];

const ACTION_OPTIONS = [
  { value: "add_tag", label: "Add Tag" },
  { value: "remove_tag", label: "Remove Tag" },
  { value: "set_status", label: "Set Ticket Status" },
  { value: "assign", label: "Assign Ticket" },
  { value: "auto_reply", label: "Send Auto-Reply" },
  { value: "internal_note", label: "Add Internal Note" },
  { value: "update_customer", label: "Update Customer Field" },
  { value: "appstle_action", label: "Subscription Action (Appstle)" },
];

// ── Component ──

export default function RulesPage() {
  const workspace = useWorkspace();
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [isNew, setIsNew] = useState(false);
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
    fetch(`/api/workspaces/${workspace.id}/rules`).then(r => r.json()).then(setRules).finally(() => setLoading(false));
    fetch(`/api/workspaces/${workspace.id}/members`).then(r => r.json()).then(d => { if (Array.isArray(d)) setMembers(d); });
  }, [workspace.id]);

  const handleSave = async () => {
    if (!editingRule) return;
    const url = isNew
      ? `/api/workspaces/${workspace.id}/rules`
      : `/api/workspaces/${workspace.id}/rules/${editingRule.id}`;
    const method = isNew ? "POST" : "PATCH";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editingRule),
    });

    if (res.ok) {
      const saved = await res.json();
      if (isNew) {
        setRules(prev => [...prev, saved]);
      } else {
        setRules(prev => prev.map(r => r.id === saved.id ? saved : r));
      }
      setEditingRule(null);
      setIsNew(false);
    }
  };

  const handleDelete = async (ruleId: string) => {
    await fetch(`/api/workspaces/${workspace.id}/rules/${ruleId}`, { method: "DELETE" });
    setRules(prev => prev.filter(r => r.id !== ruleId));
  };

  const handleToggle = async (rule: Rule) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    if (res.ok) {
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r));
    }
  };

  const createNew = () => {
    setIsNew(true);
    setEditingRule({
      id: "",
      name: "",
      description: null,
      enabled: true,
      trigger_events: [],
      conditions: { operator: "AND", groups: [{ operator: "AND", conditions: [{ field: "", op: "equals", value: "" }] }] },
      actions: [{ type: "add_tag", params: { tag: "" } }],
      priority: 0,
      stop_processing: false,
      created_at: "",
    });
  };

  if (loading) return <div className="p-8 text-sm text-zinc-400">Loading...</div>;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Rules</h1>
          <p className="mt-1 text-sm text-zinc-500">Automate actions when events happen.</p>
        </div>
        <button onClick={createNew} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          New Rule
        </button>
      </div>

      {/* Rule list */}
      {!editingRule && (
        <div className="mt-6 space-y-2">
          {rules.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-400">No rules yet. Create one to get started.</p>
          ) : (
            rules.map(rule => (
              <div key={rule.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{rule.name || "Untitled"}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${rule.enabled ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"}`}>
                      {rule.enabled ? "Active" : "Disabled"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {rule.trigger_events.map(e => (
                      <span key={e} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] text-zinc-500 dark:bg-zinc-800">{TRIGGER_OPTIONS.find(t => t.value === e)?.label || e}</span>
                    ))}
                    <span className="text-[9px] text-zinc-400">
                      → {rule.actions.map(a => ACTION_OPTIONS.find(o => o.value === a.type)?.label || a.type).join(", ")}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleToggle(rule)} className="text-xs text-zinc-400 hover:text-zinc-600">{rule.enabled ? "Disable" : "Enable"}</button>
                  <button onClick={() => { setEditingRule(rule); setIsNew(false); }} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">Edit</button>
                  <button onClick={() => handleDelete(rule.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Rule editor */}
      {editingRule && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{isNew ? "New Rule" : "Edit Rule"}</h2>

          {/* Name */}
          <div className="mt-4">
            <label className="block text-xs font-medium text-zinc-500">Name</label>
            <input
              value={editingRule.name}
              onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              placeholder="e.g. Tag billing issues"
            />
          </div>

          {/* Trigger events */}
          <div className="mt-4">
            <label className="block text-xs font-medium text-zinc-500">When (trigger events)</label>
            <div className="mt-1 flex flex-wrap gap-1">
              {TRIGGER_OPTIONS.map(t => {
                const selected = editingRule.trigger_events.includes(t.value);
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => {
                      const events = selected
                        ? editingRule.trigger_events.filter(e => e !== t.value)
                        : [...editingRule.trigger_events, t.value];
                      setEditingRule({ ...editingRule, trigger_events: events });
                    }}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                      selected
                        ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400"
                        : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Conditions */}
          <div className="mt-4">
            <label className="block text-xs font-medium text-zinc-500">If (conditions)</label>
            <div className="mt-2 space-y-3">
              {editingRule.conditions.groups.map((group, gi) => (
                <div key={gi} className="rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                  {gi > 0 && (
                    <div className="mb-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const c = { ...editingRule.conditions, operator: editingRule.conditions.operator === "AND" ? "OR" as const : "AND" as const };
                          setEditingRule({ ...editingRule, conditions: c });
                        }}
                        className="rounded bg-zinc-200 px-2 py-0.5 text-[10px] font-bold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                      >
                        {editingRule.conditions.operator}
                      </button>
                    </div>
                  )}
                  <div className="space-y-2">
                    {group.conditions.map((cond, ci) => (
                      <div key={ci} className="flex items-center gap-2">
                        {ci > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              const groups = [...editingRule.conditions.groups];
                              groups[gi] = { ...groups[gi], operator: groups[gi].operator === "AND" ? "OR" : "AND" };
                              setEditingRule({ ...editingRule, conditions: { ...editingRule.conditions, groups } });
                            }}
                            className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-[9px] font-bold text-zinc-500 dark:bg-zinc-600 dark:text-zinc-300"
                          >
                            {group.operator}
                          </button>
                        )}
                        <select
                          value={cond.field}
                          onChange={(e) => {
                            const groups = [...editingRule.conditions.groups];
                            groups[gi].conditions[ci] = { ...cond, field: e.target.value };
                            setEditingRule({ ...editingRule, conditions: { ...editingRule.conditions, groups } });
                          }}
                          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                        >
                          <option value="">Select field...</option>
                          {FIELD_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </select>
                        <select
                          value={cond.op}
                          onChange={(e) => {
                            const groups = [...editingRule.conditions.groups];
                            groups[gi].conditions[ci] = { ...cond, op: e.target.value };
                            setEditingRule({ ...editingRule, conditions: { ...editingRule.conditions, groups } });
                          }}
                          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                        >
                          {OP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        {!["is_empty", "is_not_empty"].includes(cond.op) && (
                          <input
                            value={cond.value}
                            onChange={(e) => {
                              const groups = [...editingRule.conditions.groups];
                              groups[gi].conditions[ci] = { ...cond, value: e.target.value };
                              setEditingRule({ ...editingRule, conditions: { ...editingRule.conditions, groups } });
                            }}
                            placeholder="value"
                            className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            const groups = [...editingRule.conditions.groups];
                            groups[gi].conditions = groups[gi].conditions.filter((_, i) => i !== ci);
                            if (groups[gi].conditions.length === 0) {
                              setEditingRule({ ...editingRule, conditions: { ...editingRule.conditions, groups: groups.filter((_, i) => i !== gi) } });
                            } else {
                              setEditingRule({ ...editingRule, conditions: { ...editingRule.conditions, groups } });
                            }
                          }}
                          className="text-xs text-red-400 hover:text-red-600"
                        >x</button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const groups = [...editingRule.conditions.groups];
                        groups[gi].conditions.push({ field: "", op: "equals", value: "" });
                        setEditingRule({ ...editingRule, conditions: { ...editingRule.conditions, groups } });
                      }}
                      className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      + Add condition
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const groups = [...editingRule.conditions.groups, { operator: "AND" as const, conditions: [{ field: "", op: "equals", value: "" }] }];
                  setEditingRule({ ...editingRule, conditions: { ...editingRule.conditions, groups } });
                }}
                className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                + Add condition group
              </button>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-4">
            <label className="block text-xs font-medium text-zinc-500">Then (actions)</label>
            <div className="mt-2 space-y-2">
              {editingRule.actions.map((action, ai) => (
                <div key={ai} className="flex items-center gap-2">
                  <select
                    value={action.type}
                    onChange={(e) => {
                      const actions = [...editingRule.actions];
                      actions[ai] = { type: e.target.value, params: {} };
                      setEditingRule({ ...editingRule, actions });
                    }}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                  >
                    {ACTION_OPTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>

                  {/* Param inputs based on action type */}
                  {(action.type === "add_tag" || action.type === "remove_tag") && (
                    <input
                      value={action.params.tag || ""}
                      onChange={(e) => {
                        const actions = [...editingRule.actions];
                        actions[ai] = { ...action, params: { ...action.params, tag: e.target.value } };
                        setEditingRule({ ...editingRule, actions });
                      }}
                      placeholder="tag name"
                      className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                    />
                  )}
                  {action.type === "set_status" && (
                    <select
                      value={action.params.status || ""}
                      onChange={(e) => {
                        const actions = [...editingRule.actions];
                        actions[ai] = { ...action, params: { status: e.target.value } };
                        setEditingRule({ ...editingRule, actions });
                      }}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                    >
                      <option value="">Select...</option>
                      <option value="open">Open</option>
                      <option value="pending">Pending</option>
                      <option value="resolved">Resolved</option>
                      <option value="closed">Closed</option>
                    </select>
                  )}
                  {action.type === "assign" && (
                    <select
                      value={action.params.user_id || ""}
                      onChange={(e) => {
                        const actions = [...editingRule.actions];
                        actions[ai] = { ...action, params: { user_id: e.target.value } };
                        setEditingRule({ ...editingRule, actions });
                      }}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                    >
                      <option value="">Unassign</option>
                      {members.map(m => <option key={m.user_id} value={m.user_id}>{m.display_name || m.email}</option>)}
                    </select>
                  )}
                  {(action.type === "auto_reply" || action.type === "internal_note") && (
                    <input
                      value={action.params.template || action.params.body || ""}
                      onChange={(e) => {
                        const actions = [...editingRule.actions];
                        const key = action.type === "auto_reply" ? "template" : "body";
                        actions[ai] = { ...action, params: { [key]: e.target.value } };
                        setEditingRule({ ...editingRule, actions });
                      }}
                      placeholder={action.type === "auto_reply" ? "Reply template (use {{customer.first_name}})..." : "Note text..."}
                      className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                    />
                  )}
                  {action.type === "update_customer" && (
                    <>
                      <input
                        value={action.params.field || ""}
                        onChange={(e) => {
                          const actions = [...editingRule.actions];
                          actions[ai] = { ...action, params: { ...action.params, field: e.target.value } };
                          setEditingRule({ ...editingRule, actions });
                        }}
                        placeholder="field name"
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                      />
                      <input
                        value={action.params.value || ""}
                        onChange={(e) => {
                          const actions = [...editingRule.actions];
                          actions[ai] = { ...action, params: { ...action.params, value: e.target.value } };
                          setEditingRule({ ...editingRule, actions });
                        }}
                        placeholder="value"
                        className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                      />
                    </>
                  )}
                  {action.type === "appstle_action" && (
                    <select
                      value={action.params.action || ""}
                      onChange={(e) => {
                        const actions = [...editingRule.actions];
                        actions[ai] = { ...action, params: { action: e.target.value, contract_id_source: "context" } };
                        setEditingRule({ ...editingRule, actions });
                      }}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                    >
                      <option value="">Select...</option>
                      <option value="pause">Pause Subscription</option>
                      <option value="cancel">Cancel Subscription</option>
                      <option value="resume">Resume Subscription</option>
                    </select>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setEditingRule({ ...editingRule, actions: editingRule.actions.filter((_, i) => i !== ai) });
                    }}
                    className="text-xs text-red-400 hover:text-red-600"
                  >x</button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  setEditingRule({ ...editingRule, actions: [...editingRule.actions, { type: "add_tag", params: { tag: "" } }] });
                }}
                className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                + Add action
              </button>
            </div>
          </div>

          {/* Advanced */}
          <div className="mt-4 flex items-center gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-500">Priority</label>
              <input
                type="number"
                value={editingRule.priority}
                onChange={(e) => setEditingRule({ ...editingRule, priority: parseInt(e.target.value) || 0 })}
                className="mt-1 w-20 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
              />
            </div>
            <label className="flex items-center gap-1.5 pt-4 text-xs text-zinc-500">
              <input
                type="checkbox"
                checked={editingRule.stop_processing}
                onChange={(e) => setEditingRule({ ...editingRule, stop_processing: e.target.checked })}
                className="h-3 w-3 rounded border-zinc-300 text-indigo-600"
              />
              Stop processing further rules if matched
            </label>
          </div>

          {/* Save / Cancel */}
          <div className="mt-6 flex gap-2">
            <button onClick={handleSave} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
              {isNew ? "Create Rule" : "Save Changes"}
            </button>
            <button onClick={() => { setEditingRule(null); setIsNew(false); }} className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
