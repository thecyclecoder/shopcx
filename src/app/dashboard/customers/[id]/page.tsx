"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

interface Customer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  retention_score: number;
  subscription_status: string;
  total_orders: number;
  ltv_cents: number;
  first_order_at: string | null;
  last_order_at: string | null;
  tags: string[];
  created_at: string;
}

interface Order {
  id: string;
  order_number: string | null;
  email: string | null;
  total_cents: number;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  created_at: string;
}

function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function RetentionBadge({ score }: { score: number }) {
  let classes: string;
  if (score > 70) {
    classes =
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
  } else if (score >= 40) {
    classes =
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
  } else {
    classes =
      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${classes}`}
    >
      {score}/100
    </span>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-sm text-zinc-400">--</span>;
  const map: Record<string, string> = {
    paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    refunded:
      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    pending:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    fulfilled:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  };
  const cls =
    map[status] ||
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [linkedIdentities, setLinkedIdentities] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null; is_primary: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [linkEmail, setLinkEmail] = useState("");
  const [linkMessage, setLinkMessage] = useState("");
  const [suggestions, setSuggestions] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null; match_reason: string }[]>([]);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/customers/${id}`);
      if (!res.ok) {
        setError("Customer not found");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setCustomer(data.customer);
      setOrders(data.orders);
      setLinkedIdentities(data.linked_identities || []);
      setLoading(false);

      // Load link suggestions
      fetch(`/api/customers/${id}/suggestions`)
        .then((r) => r.json())
        .then((s) => setSuggestions(s.suggestions || []));
    }
    load();
  }, [id]);

  const handleLinkById = async (targetId: string, targetEmail: string, targetFirst: string | null, targetLast: string | null) => {
    setLinkMessage("");
    const res = await fetch(`/api/customers/${id}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link_to: targetId }),
    });

    if (res.ok) {
      setLinkedIdentities((prev) => [...prev, { id: targetId, email: targetEmail, first_name: targetFirst, last_name: targetLast, is_primary: false }]);
      setSuggestions((prev) => prev.filter((s) => s.id !== targetId));
      setLinkMessage("Linked!");
    } else {
      const data = await res.json();
      setLinkMessage(data.error || "Failed to link");
    }
  };

  const handleLink = async () => {
    if (!linkEmail.trim()) return;
    setLinkMessage("");

    const searchRes = await fetch(`/api/customers?search=${encodeURIComponent(linkEmail)}&limit=1`);
    const searchData = await searchRes.json();
    const target = searchData.customers?.[0];

    if (!target) {
      setLinkMessage("No customer found with that email");
      return;
    }
    if (target.id === id) {
      setLinkMessage("That's this customer");
      return;
    }

    await handleLinkById(target.id, target.email, target.first_name, target.last_name);
    setLinkEmail("");
  };

  const handleUnlink = async (unlinkId: string) => {
    const res = await fetch(`/api/customers/${id}/links?unlink_id=${unlinkId}`, { method: "DELETE" });
    if (res.ok) {
      setLinkedIdentities((prev) => prev.filter((l) => l.id !== unlinkId));
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">{error || "Customer not found"}</p>
        <button
          onClick={() => router.push("/dashboard/customers")}
          className="mt-4 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Back to customers
        </button>
      </div>
    );
  }

  const displayName =
    [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
    customer.email;

  return (
    <div className="p-8">
      {/* Back button */}
      <button
        onClick={() => router.push("/dashboard/customers")}
        className="mb-6 flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 19.5L8.25 12l7.5-7.5"
          />
        </svg>
        Back to customers
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {displayName}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">{customer.email}</p>
          {customer.phone && (
            <p className="mt-0.5 text-sm text-zinc-400">{customer.phone}</p>
          )}
        </div>
        <RetentionBadge score={customer.retention_score} />
      </div>

      {/* Stats cards */}
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-xs font-medium uppercase text-zinc-500">LTV</p>
          <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {formatCents(customer.ltv_cents)}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-xs font-medium uppercase text-zinc-500">
            Total Orders
          </p>
          <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {customer.total_orders}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-xs font-medium uppercase text-zinc-500">
            Subscription
          </p>
          <p className="mt-1 text-xl font-semibold capitalize text-zinc-900 dark:text-zinc-100">
            {customer.subscription_status}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-xs font-medium uppercase text-zinc-500">
            Customer Since
          </p>
          <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {formatDate(customer.first_order_at || customer.created_at)}
          </p>
        </div>
      </div>

      {/* Tags */}
      {customer.tags && customer.tags.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-medium uppercase text-zinc-500">Tags</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {customer.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Linked Identities */}
      <div className="mt-6">
        <p className="text-xs font-medium uppercase text-zinc-500">Linked Identities</p>

        {linkedIdentities.length > 0 && (
          <div className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {linkedIdentities.map((li) => (
              <div key={li.id} className="flex items-center justify-between px-3 py-2">
                <button
                  onClick={() => router.push(`/dashboard/customers/${li.id}`)}
                  className="text-left"
                >
                  <span className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
                    {li.email}
                  </span>
                  {(li.first_name || li.last_name) && (
                    <span className="ml-2 text-xs text-zinc-400">
                      {[li.first_name, li.last_name].filter(Boolean).join(" ")}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => handleUnlink(li.id)}
                  className="text-xs text-zinc-400 hover:text-red-500"
                >
                  Unlink
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={linkEmail}
            onChange={(e) => setLinkEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLink()}
            placeholder="Link by email..."
            className="block flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            onClick={handleLink}
            disabled={!linkEmail.trim()}
            className="cursor-pointer rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Link
          </button>
        </div>
        {linkMessage && (
          <p className="mt-1 text-xs text-indigo-600 dark:text-indigo-400">{linkMessage}</p>
        )}

        {/* Auto-suggested matches */}
        {suggestions.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Possible Matches</p>
            <div className="mt-1.5 divide-y divide-zinc-200 rounded-lg border border-amber-200 bg-amber-50 dark:divide-zinc-700 dark:border-amber-800 dark:bg-amber-950">
              {suggestions.map((s) => (
                <div key={s.id} className="flex items-center justify-between px-3 py-2">
                  <div>
                    <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{s.email}</span>
                    {(s.first_name || s.last_name) && (
                      <span className="ml-1.5 text-[10px] text-zinc-500">
                        {[s.first_name, s.last_name].filter(Boolean).join(" ")}
                      </span>
                    )}
                    <span className="ml-1.5 rounded bg-amber-200 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-800 dark:text-amber-300">
                      {s.match_reason}
                    </span>
                  </div>
                  <button
                    onClick={() => handleLinkById(s.id, s.email, s.first_name, s.last_name)}
                    className="cursor-pointer rounded-md border border-indigo-300 px-2 py-1 text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-950"
                  >
                    Link
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Orders table */}
      <div className="mt-8">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Recent Orders
        </h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
            <thead>
              <tr className="text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Payment</th>
                <th className="px-4 py-3">Fulfillment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {orders.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-sm text-zinc-400"
                  >
                    No orders found.
                  </td>
                </tr>
              ) : (
                orders.map((o) => (
                  <tr key={o.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {o.order_number || "--"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500">
                      {formatDate(o.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
                      {formatCents(o.total_cents, o.currency)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <StatusBadge status={o.financial_status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <StatusBadge status={o.fulfillment_status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
