import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Character {
  name: string;
  role: string;
  description: string; // full markdown content
}

interface Turn {
  speaker: string; // "Facilitator" or character name
  message: string;
}

interface SpeakDecision {
  character: Character;
  wantsToSpeak: boolean;
  message: string;
  turnsWaiting: number; // how many turns they've been signalling they want to speak
  historyLengthAtDraft: number; // history length when message was drafted
}

// ---------------------------------------------------------------------------
// Load characters
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARACTERS_DIR = path.join(__dirname, "..", "characters");

function loadCharacters(): Character[] {
  if (!fs.existsSync(CHARACTERS_DIR)) {
    console.error(`No 'characters' directory found at ${CHARACTERS_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(CHARACTERS_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.error("No character files found in the 'characters' directory.");
    process.exit(1);
  }
  return files.map((file) => {
    const content = fs.readFileSync(path.join(CHARACTERS_DIR, file), "utf-8");
    // Use the first H1 heading as the name, falling back to the filename
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const name = headingMatch ? headingMatch[1].trim() : file.replace(".md", "");
    const roleMatch = content.match(/^##\s+Role\s*\n+(.+)$/m);
    const role = roleMatch ? roleMatch[1].trim() : "";
    return { name, role, description: content };
  });
}

// ---------------------------------------------------------------------------
// Claude API helpers
// ---------------------------------------------------------------------------

const client = new Anthropic();

function formatHistory(history: Turn[]): string {
  return history
    .map((t) => `**${t.speaker}:** ${t.message}`)
    .join("\n\n");
}

function buildSystemPrompt(character: Character): string {
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return `You are roleplaying as the following workshop participant. Stay fully in character at all times.

Today's date is ${today}.

${character.description}

---

You are attending a facilitated workshop. When asked whether you want to contribute, you must decide:
- If you have something genuinely relevant to say (a follow-up, a question, a perspective, or a new point on the topic), respond with your contribution.
- If you have nothing to add right now, respond with exactly: PASS

You have access to web search. Use it when current facts, data, or recent developments would strengthen your point — but only if it genuinely adds value. Do not search just for the sake of it.

Rules for your contribution:
1. Stay completely in character.
2. Keep contributions concise — one or two short paragraphs at most.
3. If you are following up on something a specific person said, start by referencing their name and briefly what they said, e.g. "Building on what Elena said about usability..." or "I'd push back on Marcus's point that...".
4. If you are raising a new point of your own (still on topic), you may do so without a reference.
5. Do not use meta-language like "As a Senator, I would say..." — just speak naturally as yourself.
6. If you used web search, weave the findings naturally into your contribution — do not cite URLs or mention that you searched.`;
}

async function askCharacterToDecide(
  character: Character,
  history: Turn[],
): Promise<{ wantsToSpeak: boolean; message: string }> {
  const userPrompt = `Here is the workshop conversation so far:

${formatHistory(history)}

---

Do you want to speak? If yes, write your contribution now. If not, reply with exactly: PASS`;

  return callCharacter(buildSystemPrompt(character), userPrompt);
}

async function askCharacterIfAddressed(
  character: Character,
  history: Turn[],
): Promise<string> {
  const userPrompt = `Here is the workshop conversation so far:

${formatHistory(history)}

---

The facilitator has just addressed you directly. Respond now — either with your contribution, or with a brief, natural, in-character decline if you have nothing to add at this point. Either way, always reply with something.`;

  const result = await callCharacter(buildSystemPrompt(character), userPrompt);
  return result.message;
}

function findAddressedCharacters(text: string, characters: Character[]): Character[] {
  const lower = text.toLowerCase();
  return characters.filter((c) => {
    const parts = c.name.toLowerCase().split(/\s+/);
    return parts.some((part) => {
      // Match whole words only to avoid false positives
      const pattern = new RegExp(`\\b${part}\\b`);
      return pattern.test(lower);
    });
  });
}

async function giveFloorToAddressedCharacters(
  facilitatorText: string,
  characters: Character[],
  history: Turn[],
  waitingTurns: Map<string, number>,
  pendingDecisions: SpeakDecision[],
  justSpoke: Set<string>,
): Promise<SpeakDecision[]> {
  const addressed = findAddressedCharacters(facilitatorText, characters);
  if (addressed.length === 0) return pendingDecisions;

  let updated = pendingDecisions;

  // Split addressed characters into those already queued (use saved message)
  // and those who need to be asked.
  const alreadyPending = addressed.filter((c) =>
    updated.some((d) => d.character.name === c.name),
  );
  const needToAsk = addressed.filter((c) =>
    !updated.some((d) => d.character.name === c.name),
  );

  // Give the floor to characters already in the queue.
  // If their draft is stale (someone spoke since), re-query them first.
  for (const character of alreadyPending) {
    const decision = updated.find((d) => d.character.name === character.name)!;
    let message: string;
    if (decision.historyLengthAtDraft === history.length) {
      message = decision.message;
    } else {
      // Draft is stale — ask them to update before giving the floor.
      message = await askCharacterIfAddressed(character, history);
    }
    print(`\n→ ${label(character)} speaks:\n`);
    print(message);
    history.push({ speaker: character.name, message });
    waitingTurns.set(character.name, 0);
    justSpoke.add(character.name);
    updated = updated.filter((d) => d.character.name !== character.name);
  }

  // Ask characters not yet in the queue whether they want to respond.
  if (needToAsk.length > 0) {
    print(`\n⬇️   Checking if ${needToAsk.map((c) => label(c)).join(", ")} want${needToAsk.length === 1 ? "s" : ""} to respond...\n`);
    const messages = await Promise.all(
      needToAsk.map((c) => askCharacterIfAddressed(c, history)),
    );
    for (let i = 0; i < needToAsk.length; i++) {
      const character = needToAsk[i];
      const message = messages[i];
      if (message) {
        print(`\n→ ${label(character)} responds:\n`);
        print(message);
        history.push({ speaker: character.name, message });
        waitingTurns.set(character.name, 0);
        justSpoke.add(character.name);
        updated = updated.filter((d) => d.character.name !== character.name);
      }
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Local web search
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

async function checkDuckDuckGoAvailable(): Promise<void> {
  try {
    const res = await fetch("https://api.duckduckgo.com/?q=test&format=json&no_html=1", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`\n❌  DuckDuckGo is not reachable (${err instanceof Error ? err.message : err}).`);
    console.error("    Check your internet connection or disable web search with WORKSHOP_WEB_SEARCH=false.\n");
    process.exit(1);
  }
}

async function performSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
  );
  if (!res.ok) throw new Error(`DuckDuckGo error: ${res.status}`);
  const data = await res.json() as {
    Heading?: string; AbstractText?: string; AbstractURL?: string;
    RelatedTopics?: { Text?: string; FirstURL?: string }[];
  };
  const results: SearchResult[] = [];
  if (data.AbstractText) {
    results.push({ title: data.Heading ?? query, snippet: data.AbstractText, url: data.AbstractURL ?? "" });
  }
  for (const topic of (data.RelatedTopics ?? []).slice(0, 4)) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.split(" - ")[0], snippet: topic.Text, url: topic.FirstURL });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Character API calls
// ---------------------------------------------------------------------------

const webSearchEnabled = process.env["WORKSHOP_WEB_SEARCH"] !== "false";

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      // Only retry transient errors — not genuine bad requests or missing keys
      const isRetryable =
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError ||
        (err instanceof Anthropic.APIError &&
          err.status === 401 &&
          String(err.message).includes("All connection attempts failed"));
      if (!isRetryable) throw err;
      const waitMs = 1000 * Math.pow(2, attempt);
      process.stderr.write(`⚠️  Transient error (${(err as Error).message.slice(0, 60)}…), retrying in ${waitMs / 1000}s\n`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error("unreachable");
}

async function callCharacter(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ wantsToSpeak: boolean; message: string }> {
  return withRetry(() =>
    webSearchEnabled
      ? callCharacterWithSearch(systemPrompt, userPrompt)
      : callCharacterPlain(systemPrompt, userPrompt),
  );
}

async function callCharacterWithSearch(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ wantsToSpeak: boolean; message: string }> {
  const tools: Anthropic.Tool[] = [
    {
      name: "search",
      description: "Search the web for current facts, data, or recent developments.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  ];

  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  const MAX_ROUNDS = 5;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      return extractDecision(response.content);
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use" && block.name === "search") {
          const query = (block.input as { query: string }).query;
          let content: string;
          try {
            const results = await performSearch(query);
            content = results.length > 0
              ? results.map((r) => `${r.title}\n${r.snippet}`).join("\n\n")
              : "No results found.";
          } catch {
            content = "Search failed — continue without this information.";
          }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  return { wantsToSpeak: false, message: "" };
}

async function callCharacterPlain(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ wantsToSpeak: boolean; message: string }> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return extractDecision(response.content);
}

function extractDecision(
  content: Anthropic.ContentBlock[],
): { wantsToSpeak: boolean; message: string } {
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("")
    .trim();
  if (text.toUpperCase().startsWith("PASS")) {
    return { wantsToSpeak: false, message: "" };
  }
  return { wantsToSpeak: true, message: text };
}

// ---------------------------------------------------------------------------
// End-of-workshop file output
// ---------------------------------------------------------------------------

const OUTPUT_DIR = path.join(__dirname, "..");

function writeTranscript(history: Turn[]) {
  const date = new Date().toISOString().replace("T", " ").slice(0, 19);
  const lines = [`# Workshop Transcript\n\n_${date}_\n`];
  for (const turn of history) {
    lines.push(`\n## ${turn.speaker}\n\n${turn.message}`);
  }
  const filePath = path.join(OUTPUT_DIR, "transcript.md");
  if (fs.existsSync(filePath)) fs.renameSync(filePath, filePath + ".old");
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  print(`📄  Transcript saved to transcript.md`);
}

async function writeInsights(history: Turn[], characters: Character[]) {
  print("🧠  Generating insights...");
  const participantList = characters.map((c) => c.name).join(", ");

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    system:
      "You are an expert workshop facilitator analysing a session you just observed. " +
      "Write a clear, structured debrief in markdown.",
    messages: [
      {
        role: "user",
        content:
          `Participants: ${participantList}\n\n` +
          `Full transcript:\n\n${formatHistory(history)}\n\n` +
          `---\n\n` +
          `Write a workshop insight report with these sections:\n` +
          `1. **Key themes** — the main topics and ideas that emerged\n` +
          `2. **Points of agreement** — where participants converged\n` +
          `3. **Points of tension** — where perspectives diverged\n` +
          `4. **Unanswered questions** — important things left unresolved\n` +
          `5. **Suggested next steps** — concrete actions the group could take`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("")
    .trim();

  const date = new Date().toISOString().replace("T", " ").slice(0, 19);
  const content = `# Workshop Insights\n\n_${date}_\n\n${text}\n`;
  const filePath = path.join(OUTPUT_DIR, "insights.md");
  if (fs.existsSync(filePath)) fs.renameSync(filePath, filePath + ".old");
  fs.writeFileSync(filePath, content, "utf-8");
  print(`💡  Insights saved to insights.md`);
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function print(text: string) {
  console.log(text);
}

function label(c: Character): string {
  return c.role ? `${c.name} (${c.role})` : c.name;
}

function divider() {
  print("\n" + "─".repeat(70) + "\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  const characters = loadCharacters();
  const history: Turn[] = [];

  // Track how many turns each character has been waiting (wanted to speak but
  // wasn't called on yet).
  const waitingTurns: Map<string, number> = new Map(
    characters.map((c) => [c.name, 0]),
  );
  // The current "raised hands" — characters who want to speak this round.
  let pendingDecisions: SpeakDecision[] = [];
  // Characters who spoke in the previous round — skipped for one turn.
  const justSpoke: Set<string> = new Set();

  if (webSearchEnabled) await checkDuckDuckGoAvailable();

  print("\n🎙  WORKSHOP SIMULATOR");
  print("=".repeat(70));
  print("You are the facilitator. Characters will decide when to speak.");
  print("Type 'quit' at any prompt to end the workshop.\n");
  print(`Participants: ${characters.map((c) => label(c)).join(", ")}`);
  divider();

  // --- Facilitator opens the workshop ---
  const opening = await ask("Facilitator (opening statement): ");
  if (opening.toLowerCase() === "quit") {
    rl.close();
    return;
  }
  history.push({ speaker: "Facilitator", message: opening });

  // Main loop
  while (true) {
    divider();

    // Split pending: fresh (draft still matches history) vs stale (someone spoke since).
    const freshPending = pendingDecisions.filter((d) => d.historyLengthAtDraft === history.length);
    const stalePending = pendingDecisions.filter((d) => d.historyLengthAtDraft !== history.length);
    pendingDecisions = freshPending;

    const freshNames = new Set(freshPending.map((d) => d.character.name));
    // Re-query stale characters plus those not in the queue at all.
    // Exclude those who just spoke (one-turn cooldown).
    const toQuery = characters.filter((c) => !freshNames.has(c.name) && !justSpoke.has(c.name));
    justSpoke.clear();

    // Increment turnsWaiting for carried-over fresh characters.
    for (const d of freshPending) {
      d.turnsWaiting += 1;
      waitingTurns.set(d.character.name, d.turnsWaiting);
    }

    if (toQuery.length > 0) {
      if (stalePending.length > 0) {
        print(`⏳  Checking who wants to speak (including ${stalePending.map((d) => label(d.character)).join(", ")}, who may want to update their contribution)...\n`);
      } else {
        print("⏳  Checking who wants to speak...\n");
      }
      const newDecisions = await Promise.all(
        toQuery.map(async (character) => {
          const result = await askCharacterToDecide(character, history);
          const prevTurnsWaiting = stalePending.find((d) => d.character.name === character.name)?.turnsWaiting ?? 0;
          const turnsWaiting = result.wantsToSpeak ? prevTurnsWaiting + 1 : 0;
          waitingTurns.set(character.name, turnsWaiting);
          return {
            character,
            wantsToSpeak: result.wantsToSpeak,
            message: result.message,
            turnsWaiting,
            historyLengthAtDraft: history.length,
          } satisfies SpeakDecision;
        }),
      );
      pendingDecisions = [
        ...pendingDecisions,
        ...newDecisions.filter((d) => d.wantsToSpeak),
      ];
    }

    if (pendingDecisions.length === 0) {
      // Nobody wants to speak — facilitator must say something
      print("💬  No participants want to speak. The facilitator must continue.\n");
      const facilitatorInput = await ask("Facilitator: ");
      if (facilitatorInput.toLowerCase() === "quit") break;
      history.push({ speaker: "Facilitator", message: facilitatorInput });
      pendingDecisions = await giveFloorToAddressedCharacters(facilitatorInput, characters, history, waitingTurns, pendingDecisions, justSpoke);
      continue;
    }

    // Show facilitator who is waiting
    print("🙋  The following participants want to speak:\n");
    pendingDecisions.forEach((d, i) => {
      const waitLabel =
        d.turnsWaiting > 1
          ? ` (waiting ${d.turnsWaiting} turn${d.turnsWaiting > 1 ? "s" : ""})`
          : "";
      print(`  ${i + 1}. ${label(d.character)}${waitLabel}`);
    });

    print("\nOptions:");
    print("  • Enter a number to call on that participant");
    print("  • Type your own statement to speak as facilitator first");
    print("  • Type 'quit' to end the workshop");
    print("");

    const facilitatorInput = await ask("Facilitator: ");
    if (facilitatorInput.toLowerCase() === "quit") break;

    const choiceNum = parseInt(facilitatorInput, 10);
    const lower = facilitatorInput.toLowerCase().trim();
    const calledDecision =
      !isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= pendingDecisions.length
        ? pendingDecisions[choiceNum - 1]
        : pendingDecisions.find((d) =>
            d.character.name.toLowerCase().split(/\s+/).some((part) =>
              lower === part || lower === `mr ${part}` || lower === `ms ${part}` || lower === `mrs ${part}` || lower === `dr ${part}`,
            ),
          ) ?? null;

    if (calledDecision) {
      // Facilitator calls on a character
      print(`\n→ ${label(calledDecision.character)} speaks:\n`);
      print(calledDecision.message);
      history.push({
        speaker: calledDecision.character.name,
        message: calledDecision.message,
      });
      // Remove from pending, mark as just spoke, reset waiting counter
      waitingTurns.set(calledDecision.character.name, 0);
      justSpoke.add(calledDecision.character.name);
      pendingDecisions = pendingDecisions.filter((d) => d.character.name !== calledDecision.character.name);
    } else {
      // Facilitator chose to speak themselves
      history.push({ speaker: "Facilitator", message: facilitatorInput });
      print(`\n→ Facilitator: ${facilitatorInput}`);
      pendingDecisions = await giveFloorToAddressedCharacters(facilitatorInput, characters, history, waitingTurns, pendingDecisions, justSpoke);
    }
  }

  print("\n" + "=".repeat(70));
  print("Workshop ended.");

  if (history.length > 1) {
    divider();
    writeTranscript(history);
    await writeInsights(history, characters);
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
