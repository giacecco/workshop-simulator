# Workshop Simulator

A CLI tool that simulates a facilitated workshop with AI-driven characters. You play the facilitator; the characters decide autonomously when to speak, can search the web to inform their contributions, and react naturally to what has been said.

## How it works

Each character is defined by a Markdown file in the `characters/` folder. At every turn, all characters are consulted in parallel: each decides independently whether they have something worth saying, optionally searching the web for current facts. The facilitator then chooses who to give the floor to.

### Turn flow

1. **Facilitator opens** with a statement to set the topic.
2. **Characters decide** — every character is queried in parallel. Each either drafts a contribution or passes.
3. **Facilitator chooses** — if anyone wants to speak, the facilitator is shown the list and picks who goes next. If nobody wants to speak, the facilitator must say something to keep the discussion going.
4. **Direct addressing** — if the facilitator mentions a character by name, that character always replies immediately. If they were already in the waiting queue with a fresh draft (no one has spoken since they queued), their saved contribution is used directly with no extra API call. If their draft is stale, or they were not in the queue, they are queried on the spot and either contribute or decline briefly in character. Either way the response is recorded and the normal round then follows.
5. **Repeat** until the facilitator types `quit`.

On exit the simulator writes two files:
- `transcript.md` — the full conversation, one section per turn
- `insights.md` — an AI-generated debrief covering key themes, points of agreement and tension, unanswered questions, and suggested next steps

### Character contributions

When a character speaks they either:
- **Follow up** on something specific, referencing the speaker's name and what was said
- **Raise a new point** of their own, still on the topic

Characters know today's date and can search the web (via DuckDuckGo) to back up their contributions with current information.

### Waiting queue

Characters who want to speak but are not called on remain queued. The facilitator is shown how many turns each character has been waiting, but is free to call on them in any order.

Characters already in the queue are not re-queried each round — their contribution is held until they are called on. However, if another participant speaks in the meantime, their draft is considered stale and they are re-queried so they can respond to what was just said. A character who has just spoken is not queried again in the immediately following round.

## Setup

**Requirements:** [Bun](https://bun.sh), an Anthropic API key.

```bash
git clone <repo>
cd workshop-simulator
bun install
export ANTHROPIC_API_KEY=your_key_here
bun start
```

## Defining characters

Add a Markdown file to the `characters/` folder. The first `#` heading becomes the character's name. Describe their role, personality, background, and communication style — the richer the description, the more distinctive their voice.

```markdown
# Ada Lovelace

## Role
Mathematician and writer, widely regarded as the first computer programmer

## Personality
Visionary and precise. Ada connects mathematical rigour with imaginative leaps...

## Background
...

## Communication style
...
```

The three example characters are US senators representing a Democrat, a Trump-supporting Republican, and a Trump-sceptic Republican.

## Facilitator controls

| Input | Action |
|---|---|
| A statement | Speak as facilitator; any named characters get an immediate chance to respond |
| A number | Call on the nth character in the waiting list |
| A name (`Elena`, `Okafor`, `Mr Obi`, `Ms Vasquez`, `Dr ...`) | Call on that character by name |
| `/Name instruction` | Send a secret order to a character (e.g. `/James get angry with Elena`). Not logged to the transcript. The character is queried immediately and jumps to the top of the queue. Orders that violate the model's content policy are silently refused by the character. |
| `quit` | End the workshop and generate output files |

### Facilitator history

All facilitator inputs are saved to `.workshop_history` in the project root and persist across runs. Use the up/down arrow keys to navigate previous inputs, just like a shell. Pure-number inputs (used to call on participants by position) are not saved, and history is capped at 50 entries.

## CLI options

| Option | Description |
|---|---|
| `--opening "text"` | Set the opening statement from the command line, skipping the prompt |

Example:

```bash
bun start --opening "Today we're discussing AI regulation in the EU."
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. Your Anthropic API key |
| `WORKSHOP_WEB_SEARCH` | `true` | Set to `false` to disable web search |

## Output files

Both files are written to the project root when you quit.

- **`transcript.md`** — complete record of the workshop, suitable for sharing
- **`insights.md`** — structured debrief: key themes, agreements, tensions, open questions, and next steps

## Licence

Capgemini — all rights reserved.
