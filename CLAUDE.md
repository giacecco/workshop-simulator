# Workshop Simulator — Claude Code notes

## Runtime

- Uses **Bun** (not Node.js / npm). Run with `bun start` or `bun run src/simulator.ts`.
- TypeScript is compiled by Bun natively — no build step needed for development.

## Code conventions

- All source is in `src/simulator.ts` (single-file project).
- Characters are loaded from `characters/*.md` at startup.
- The Anthropic SDK client is a module-level singleton (`const client = new Anthropic()`).

## Key design decisions

- Characters are queried in parallel via `Promise.all` each round.
- Pending decisions track `historyLengthAtDraft` to detect stale drafts.
- Secret orders use `askCharacterIfAddressed` (forced response, no PASS) so the character always joins the queue.
- Facilitator command history is persisted to `.workshop_history` (gitignored) across runs.
