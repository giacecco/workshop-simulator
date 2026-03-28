# Workshop Simulator

A CLI tool that simulates a facilitated workshop with AI-driven characters. You play the facilitator; the characters decide autonomously when to speak, can search the web to inform their contributions, and react naturally to what has been said.

## How it works

Each character is defined by a Markdown file in the `characters/` folder. At every turn, all characters are consulted in parallel: each decides independently whether they have something worth saying, optionally searching the web for current facts. The facilitator then chooses who to give the floor to.

### Turn flow

1. **Facilitator opens** with a statement to set the topic.
2. **Characters decide** — every character is queried in parallel. Each either drafts a contribution or passes.
3. **Facilitator chooses** — if anyone wants to speak, the facilitator is shown the list and picks who goes next. If nobody wants to speak, the facilitator must say something to keep the discussion going.
4. **Direct addressing** — if the facilitator mentions a character by name, that character is immediately given a chance to respond before the next general round.
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

## Setup

**Requirements:** Node.js 18+, an Anthropic API key.

```bash
git clone <repo>
cd workshop-simulator
npm install
export ANTHROPIC_API_KEY=your_key_here
npm start
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
| `quit` | End the workshop and generate output files |

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

MIT — see `LICENSE`.
