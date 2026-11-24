import Link from "next/link";

export const metadata = {
  title: "AI Shopping Assistant - Superfoods",
  description:
    "Ask ChatGPT, Claude or Grok about Superfoods products. Our shopping assistant recommends by your situation and answers from real product intelligence.",
};

const EXAMPLE_PROMPTS = [
  "I keep hitting an afternoon energy slump — what would you suggest?",
  "I want to swap my morning coffee for something gentler. Options?",
  "Compare Superfood Tabs and the coffee for someone new to this.",
  "What's in Superfood Tabs, and how much caffeine does it have?",
  "What do reviewers say about bloating?",
  "Build me a 3-pack on subscribe and give me a checkout link.",
];

export default function ShoppingAssistantPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="mb-8 inline-block text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        &larr; Back
      </Link>
      <h1 className="mb-4 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
        AI Shopping Assistant
      </h1>
      <p className="mb-8 text-sm text-zinc-500">For ChatGPT, Claude and Grok</p>

      <div className="prose prose-zinc dark:prose-invert max-w-none space-y-6 text-zinc-700 dark:text-zinc-300">
        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">What it does</h2>
          <p>
            Our shopping assistant lets ChatGPT, Claude and Grok answer questions about Superfoods products
            using our real product intelligence — ingredient research, science- and review-backed benefits,
            thousands of customer reviews, FAQs and policies — instead of thin catalog copy. It recommends
            products by the situation you describe, shows product cards, and can build a cart that hands off
            to our own secure checkout.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">What it can do</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Recommend products for the situation you&apos;re in, with what other customers noticed.</li>
            <li>Explain ingredients, doses, supplement facts (including caffeine) and how to use a product.</li>
            <li>Answer product and policy questions from verified knowledge only.</li>
            <li>Show the best customer reviews, optionally on a topic.</li>
            <li>Compare products side by side.</li>
            <li>Build a cart and give you a secure checkout link on our own store.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Example prompts</h2>
          <ul className="list-disc pl-6 space-y-1">
            {EXAMPLE_PROMPTS.map((p) => (
              <li key={p}>&ldquo;{p}&rdquo;</li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Health &amp; safety</h2>
          <p>
            These statements have not been evaluated by the Food and Drug Administration. Our products are
            not intended to diagnose, treat, cure, or prevent any disease. If you&apos;re pregnant, nursing,
            under 18, taking medication, or managing a medical condition, the assistant will suggest you check
            with your doctor before starting any supplement.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Privacy</h2>
          <p>
            See the <Link href="/privacy" className="underline">Privacy Policy</Link> (section 8) for exactly what
            the assistant receives, what we log, and what we never store.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Contact &amp; support</h2>
          <p>
            Questions or issues with the AI shopping assistant? Email{" "}
            <a href="mailto:support@shopcx.ai" className="underline">support@shopcx.ai</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
