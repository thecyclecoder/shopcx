"use client";

import Image from "next/image";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const handleGoogleLogin = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-sm space-y-8 px-6">
        <div className="flex flex-col items-center gap-3">
          <Image
            src="/logo.svg"
            alt="ShopCX.AI Logo"
            width={64}
            height={64}
            priority
          />
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Shop<span className="text-indigo-500">CX</span>
            <span className="text-sm font-medium text-violet-400">.AI</span>
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            AI-powered customer experience
          </p>
        </div>

        <button
          onClick={handleGoogleLogin}
          className="flex w-full items-center justify-center gap-3 rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </button>

        <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
          By signing in, you agree to our{" "}
          <a href="/terms" className="underline hover:text-zinc-600 dark:hover:text-zinc-300">
            Terms of Service
          </a>
          ,{" "}
          <a href="/privacy" className="underline hover:text-zinc-600 dark:hover:text-zinc-300">
            Privacy Policy
          </a>
          , and{" "}
          <a href="/eula" className="underline hover:text-zinc-600 dark:hover:text-zinc-300">
            EULA
          </a>
          .
        </p>
      </div>
    </div>
  );
}
