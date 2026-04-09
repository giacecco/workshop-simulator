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
- The PASS instruction lives only in the `askCharacterToDecide` user prompt, not in the system prompt. This ensures characters always produce a real response when directly addressed or given a secret order.
- Secret orders use `askCharacterIfAddressed` (forced response, no PASS option) so the character always joins the queue. If the model still returns an empty message (e.g. content policy refusal), a warning is shown and the character is not added to the queue.
- Secret orders respect the model's content policy — instructions that ask for defamatory or harmful content will be silently ignored by the character.
- Facilitator command history is persisted to `.workshop_history` (gitignored) across runs. Pure-number entries (used to call on participants) are excluded, and only the 50 most recent entries are kept.
