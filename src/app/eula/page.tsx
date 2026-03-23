import Link from "next/link";

export const metadata = {
  title: "End User License Agreement - ShopCX",
};

export default function EulaPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="mb-8 inline-block text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        &larr; Back
      </Link>
      <h1 className="mb-8 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
        End User License Agreement (EULA)
      </h1>
      <p className="mb-4 text-sm text-zinc-500">Last updated: March 23, 2026</p>

      <div className="prose prose-zinc dark:prose-invert max-w-none space-y-6 text-zinc-700 dark:text-zinc-300">
        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">1. Agreement</h2>
          <p>
            This End User License Agreement (&quot;EULA&quot;) is a legal agreement between you and
            Superfoods Company (&quot;Licensor&quot;) for the use of ShopCX and any related software,
            applications, and services (collectively, the &quot;Software&quot;).
          </p>
          <p>
            By installing, copying, or otherwise using the Software, you agree to be bound by the terms
            of this EULA. If you do not agree, do not use the Software.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">2. License Grant</h2>
          <p>
            The Licensor grants you a limited, non-exclusive, non-transferable, revocable license to
            access and use the Software for your personal or internal business purposes, subject to the
            terms of this EULA.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">3. Restrictions</h2>
          <p>You may not:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Copy, modify, or distribute the Software or any portion thereof.</li>
            <li>Reverse engineer, decompile, or disassemble the Software.</li>
            <li>Rent, lease, lend, sell, or sublicense the Software.</li>
            <li>Use the Software to develop competing products or services.</li>
            <li>Remove or alter any proprietary notices, labels, or marks on the Software.</li>
            <li>Use the Software in any manner that violates applicable laws or regulations.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">4. Ownership</h2>
          <p>
            The Software is licensed, not sold. The Licensor retains all right, title, and interest in
            and to the Software, including all intellectual property rights. This EULA does not grant you
            any rights to trademarks or service marks of the Licensor.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">5. Data Collection</h2>
          <p>
            The Software may collect certain data as described in our{" "}
            <a href="/privacy" className="underline">Privacy Policy</a>. By using the Software,
            you consent to such data collection.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">6. Updates</h2>
          <p>
            The Licensor may provide updates, patches, or new versions of the Software from time to time.
            Such updates may be required for continued use and may be installed automatically. Updated
            versions are subject to this EULA unless a separate agreement is provided.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">7. Termination</h2>
          <p>
            This EULA is effective until terminated. It will terminate automatically if you fail to comply
            with any term. Upon termination, you must cease all use of the Software and destroy any copies
            in your possession. The Licensor may also terminate this EULA at any time with or without notice.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">8. Disclaimer of Warranties</h2>
          <p>
            THE SOFTWARE IS PROVIDED &quot;AS IS&quot; WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
            INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
            AND NONINFRINGEMENT. THE LICENSOR DOES NOT WARRANT THAT THE SOFTWARE WILL BE ERROR-FREE OR
            UNINTERRUPTED.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">9. Limitation of Liability</h2>
          <p>
            IN NO EVENT SHALL THE LICENSOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
            OR CONSEQUENTIAL DAMAGES ARISING OUT OF OR IN CONNECTION WITH THIS EULA OR THE USE OF THE
            SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. THE LICENSOR&apos;S TOTAL
            LIABILITY SHALL NOT EXCEED THE AMOUNT PAID BY YOU FOR THE SOFTWARE IN THE TWELVE (12) MONTHS
            PRECEDING THE CLAIM.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">10. Governing Law</h2>
          <p>
            This EULA shall be governed by and construed in accordance with the laws of the State of Delaware,
            United States, without regard to its conflict of law provisions.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">11. Contact</h2>
          <p>
            For questions regarding this EULA, contact us at{" "}
            <a href="mailto:legal@shopcx.ai" className="underline">legal@shopcx.ai</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
