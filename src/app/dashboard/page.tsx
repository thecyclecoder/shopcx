export default function DashboardPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Overview
      </h1>
      <p className="mt-2 text-sm text-zinc-500">
        Welcome to ShopCX.ai. Your workspace is ready.
      </p>

      {/* Placeholder stats */}
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Open Tickets", value: "0" },
          { label: "Customers", value: "0" },
          { label: "Avg. Retention Score", value: "—" },
          { label: "AI Resolution Rate", value: "—" },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="text-sm font-medium text-zinc-500">{stat.label}</p>
            <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {stat.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
