"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";

export default function PortalLoginPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const [status, setStatus] = useState<"verifying" | "success" | "error">("verifying");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("No login token provided.");
      return;
    }

    fetch(`/api/portal/magic-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && data.redirectUrl) {
          setStatus("success");
          // Redirect to the portal with session cookie
          window.location.href = data.redirectUrl;
        } else {
          setStatus("error");
          setError(data.error || "Invalid or expired link. Please request a new one.");
        }
      })
      .catch(() => {
        setStatus("error");
        setError("Something went wrong. Please try again.");
      });
  }, [token, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg dark:bg-zinc-900">
        {status === "verifying" && (
          <div className="text-center">
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
            <p className="text-sm text-zinc-500">Signing you in...</p>
          </div>
        )}
        {status === "success" && (
          <div className="text-center">
            <p className="text-sm text-emerald-600">Signed in! Redirecting...</p>
          </div>
        )}
        {status === "error" && (
          <div className="text-center">
            <p className="mb-2 text-sm font-medium text-red-600">Login Failed</p>
            <p className="text-sm text-zinc-500">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
