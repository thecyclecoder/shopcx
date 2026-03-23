import Link from "next/link";

export const metadata = {
  title: "Privacy Policy - ShopCX",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="mb-8 inline-block text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        &larr; Back
      </Link>
      <h1 className="mb-8 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
        Privacy Policy
      </h1>
      <p className="mb-4 text-sm text-zinc-500">Last updated: March 23, 2026</p>

      <div className="prose prose-zinc dark:prose-invert max-w-none space-y-6 text-zinc-700 dark:text-zinc-300">
        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">1. Introduction</h2>
          <p>
            Superfoods Company (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) operates the ShopCX platform
            (the &quot;Service&quot;) accessible at shopcx.ai. This Privacy Policy explains how we collect,
            use, disclose, and safeguard your information when you use our Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">2. Information We Collect</h2>
          <p>We may collect the following types of information:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Account Information:</strong> Name, email address, and profile picture provided through Google authentication.</li>
            <li><strong>Usage Data:</strong> Information about how you interact with the Service, including pages visited, features used, and timestamps.</li>
            <li><strong>Device Information:</strong> Browser type, operating system, IP address, and device identifiers.</li>
            <li><strong>Cookies and Tracking:</strong> We use cookies and similar technologies to maintain sessions and improve the Service.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">3. How We Use Your Information</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>To provide, maintain, and improve the Service.</li>
            <li>To authenticate your identity and manage your account.</li>
            <li>To communicate with you about updates, support, and administrative matters.</li>
            <li>To monitor usage and analyze trends to improve user experience.</li>
            <li>To detect, prevent, and address technical issues or security threats.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">4. Sharing of Information</h2>
          <p>
            We do not sell your personal information. We may share information with:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Service Providers:</strong> Third-party vendors who assist in operating the Service (e.g., hosting, analytics).</li>
            <li><strong>Legal Requirements:</strong> When required by law, regulation, or legal process.</li>
            <li><strong>Business Transfers:</strong> In connection with a merger, acquisition, or sale of assets.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">5. Data Retention</h2>
          <p>
            We retain your information for as long as your account is active or as needed to provide the Service.
            You may request deletion of your account and associated data by contacting us.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">6. Security</h2>
          <p>
            We implement appropriate technical and organizational measures to protect your information.
            However, no method of transmission over the Internet is 100% secure.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">7. Your Rights</h2>
          <p>Depending on your jurisdiction, you may have the right to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Access, correct, or delete your personal information.</li>
            <li>Object to or restrict processing of your data.</li>
            <li>Data portability.</li>
            <li>Withdraw consent at any time.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">8. Contact Us</h2>
          <p>
            If you have questions about this Privacy Policy, please contact us at{" "}
            <a href="mailto:privacy@shopcx.ai" className="underline">privacy@shopcx.ai</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
