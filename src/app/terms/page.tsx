import Link from "next/link";

export const metadata = {
  title: "Terms and Conditions - ShopCX",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="mb-8 inline-block text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        &larr; Back
      </Link>
      <h1 className="mb-8 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
        Terms and Conditions
      </h1>
      <p className="mb-4 text-sm text-zinc-500">Last updated: March 23, 2026</p>

      <div className="prose prose-zinc dark:prose-invert max-w-none space-y-6 text-zinc-700 dark:text-zinc-300">
        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">1. Acceptance of Terms</h2>
          <p>
            By accessing or using ShopCX (&quot;the Service&quot;), operated by Superfoods Company,
            you agree to be bound by these Terms and Conditions. If you do not agree, do not use the Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">2. Eligibility</h2>
          <p>
            You must be at least 18 years old or the age of majority in your jurisdiction to use the Service.
            By using the Service, you represent that you meet this requirement.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">3. User Accounts</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>You are responsible for maintaining the security of your account credentials.</li>
            <li>You are responsible for all activity that occurs under your account.</li>
            <li>You must provide accurate and complete information when creating an account.</li>
            <li>We reserve the right to suspend or terminate accounts that violate these Terms.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">4. Acceptable Use</h2>
          <p>You agree not to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Use the Service for any unlawful purpose.</li>
            <li>Attempt to gain unauthorized access to the Service or its systems.</li>
            <li>Interfere with or disrupt the integrity or performance of the Service.</li>
            <li>Upload or transmit viruses, malware, or other harmful code.</li>
            <li>Reverse engineer, decompile, or disassemble the Service.</li>
            <li>Use the Service to infringe on the intellectual property rights of others.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">5. Intellectual Property</h2>
          <p>
            The Service, including all content, features, and functionality, is owned by Superfoods Company
            and is protected by copyright, trademark, and other intellectual property laws. You are granted a
            limited, non-exclusive, non-transferable license to use the Service for its intended purpose.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">6. Disclaimer of Warranties</h2>
          <p>
            The Service is provided &quot;AS IS&quot; and &quot;AS AVAILABLE&quot; without warranties of any kind,
            either express or implied. We do not warrant that the Service will be uninterrupted, error-free,
            or free of harmful components.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">7. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, Superfoods Company shall not be liable for any indirect,
            incidental, special, consequential, or punitive damages, or any loss of profits or revenues,
            whether incurred directly or indirectly, arising from your use of the Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">8. Termination</h2>
          <p>
            We may terminate or suspend your access to the Service at any time, with or without cause,
            and with or without notice. Upon termination, your right to use the Service will immediately cease.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">9. Changes to Terms</h2>
          <p>
            We reserve the right to modify these Terms at any time. We will notify users of material changes
            by posting the updated Terms on the Service. Continued use after changes constitutes acceptance.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">10. Governing Law</h2>
          <p>
            These Terms shall be governed by and construed in accordance with the laws of the State of Delaware,
            United States, without regard to its conflict of law provisions.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">11. Contact Us</h2>
          <p>
            If you have questions about these Terms, please contact us at{" "}
            <a href="mailto:legal@shopcx.ai" className="underline">legal@shopcx.ai</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
