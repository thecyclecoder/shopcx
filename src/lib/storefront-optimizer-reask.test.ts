import { describe, it } from "node:test";
import { deepStrictEqual } from "node:assert";
import { shouldReAskForJsonEnvelope, storefrontOptimizerReAskPrompt } from "./storefront-optimizer-reask";

describe("shouldReAskForJsonEnvelope", () => {
  it("unparseable + not yet re-asked → re_ask (the whole point of this phase)", () => {
    deepStrictEqual(
      shouldReAskForJsonEnvelope({ parsed: null, isError: false, alreadyReAsked: false }),
      "re_ask",
    );
  });

  it("unparseable + already re-asked → park (bounded to ONE re-ask, no infinite loop)", () => {
    deepStrictEqual(
      shouldReAskForJsonEnvelope({ parsed: null, isError: false, alreadyReAsked: true }),
      "park",
    );
  });

  it("isError && no parse → fail — the pre-existing failure branch, NOT re-asked", () => {
    // isError with no parseable output means the session itself blew up; a --resume on a broken
    // session would land on the same failure. The pre-existing branch stays as-is.
    deepStrictEqual(
      shouldReAskForJsonEnvelope({ parsed: null, isError: true, alreadyReAsked: false }),
      "fail",
    );
    // Even after a re-ask has been spent, isError + no parse stays "fail" — never park after
    // erroring, because the failure branch is what surfaces the error to a human.
    deepStrictEqual(
      shouldReAskForJsonEnvelope({ parsed: null, isError: true, alreadyReAsked: true }),
      "fail",
    );
  });

  it("parsed with a recognized status → continue (never re-ask a valid answer)", () => {
    for (const status of ["idle", "needs_input", "needs_build", "propose"]) {
      deepStrictEqual(
        shouldReAskForJsonEnvelope({ parsed: { status }, isError: false, alreadyReAsked: false }),
        "continue",
        `expected continue for status=${status}`,
      );
      // Even if already re-asked, a valid parse continues — no going back to park.
      deepStrictEqual(
        shouldReAskForJsonEnvelope({ parsed: { status }, isError: false, alreadyReAsked: true }),
        "continue",
        `expected continue for status=${status} + alreadyReAsked`,
      );
    }
  });

  it("parsed but unknown status → NOT re-asked (that is the neighboring branch, untouched)", () => {
    // The spec says "a parsed-but-unknown status still parks. This phase changes ONLY the
    // unparseable case." Passing a parsed-with-unrecognized-status object into this helper would
    // only happen if a caller mis-wires it, but we still return "park" (not "re_ask") — a bad
    // status field is a semantic failure, not a formatting slip, and a re-ask can't fix it.
    deepStrictEqual(
      shouldReAskForJsonEnvelope({ parsed: { status: "ran_the_thing" }, isError: false, alreadyReAsked: false }),
      "park",
    );
  });

  it("parsed with no status field is treated as unparseable → re_ask on first pass", () => {
    // A JSON blob that landed without the `status` key is the same class of failure as no JSON at
    // all — the parser could not extract a decision. The re-ask is the right response.
    deepStrictEqual(
      shouldReAskForJsonEnvelope({ parsed: null, isError: false, alreadyReAsked: false }),
      "re_ask",
    );
  });
});

describe("storefrontOptimizerReAskPrompt", () => {
  it("names the four recognized statuses so the model re-emits the same shape", () => {
    const prompt = storefrontOptimizerReAskPrompt();
    for (const status of ["idle", "needs_input", "needs_build", "propose"]) {
      if (!prompt.includes(`"${status}"`)) {
        throw new Error(`re-ask prompt is missing status "${status}" — model can't recover the envelope without it`);
      }
    }
  });

  it("forbids re-analysis — same session, JSON envelope only, do NOT change the answer", () => {
    const prompt = storefrontOptimizerReAskPrompt().toLowerCase();
    if (!prompt.includes("do not re-read") && !prompt.includes("do not re-run")) {
      throw new Error("re-ask prompt must forbid re-reading / re-running tools — otherwise it doubles the spend");
    }
    if (!prompt.includes("do not change the answer")) {
      throw new Error("re-ask prompt must tell the model NOT to change the answer — it already decided");
    }
  });
});
