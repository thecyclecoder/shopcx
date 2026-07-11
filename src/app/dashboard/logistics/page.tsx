import { redirect } from "next/navigation";

// Logistics area lands on Replenishment (Marco's primary surface).
export default function LogisticsIndex() {
  redirect("/dashboard/logistics/replenishment");
}
