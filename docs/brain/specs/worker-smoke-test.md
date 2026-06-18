# Worker smoke test ✅

Throwaway spec to validate the box build worker end-to-end (queue → claim → `claude -p` on Max → tsc → `claude/*` PR). Delete after the loop is proven.

## Phase 1 — write a marker file ⏳
- Create a new file `docs/brain/_worker-smoke-output.md` containing exactly one line: `built by the box worker on Max`.
- Do **not** modify any code or any other file. This is only here to prove the pipeline.
