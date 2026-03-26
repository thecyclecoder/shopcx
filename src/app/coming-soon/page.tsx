import Image from "next/image";

export const metadata = {
  title: "Coming Soon | ShopCX.ai",
};

export default function ComingSoonPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
      <Image src="/logo.svg" alt="ShopCX.ai" width={64} height={64} priority />
      <h1 className="mt-6 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
        Shop<span className="text-indigo-500">CX</span>
        <span className="text-sm font-medium text-violet-400">.ai</span>
      </h1>
      <p className="mt-3 max-w-sm text-center text-zinc-500 dark:text-zinc-400">
        The AI-powered retention operating system. We&apos;re not quite ready yet, but we will be soon.
      </p>
      <div className="mt-8 rounded-full border border-indigo-200 bg-indigo-50 px-5 py-2 text-sm font-medium text-indigo-600 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-400">
        Coming Soon
      </div>
    </div>
  );
}
