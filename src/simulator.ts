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
    return { name, description: content };
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

async function askCharacterToDecide(
  character: Character,
  history: Turn[],
): Promise<{ wantsToSpeak: boolean; message: string }> {
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const systemPrompt = `You are roleplaying as the following workshop participant. Stay fully in character at all times.

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
5. Do not use meta-language like "As a UX Designer, I would say..." — just speak naturally as yourself.
6. If you used web search, weave the findings naturally into your contribution — do not cite URLs or mention that you searched.`;

  const userPrompt = `Here is the workshop conversation so far:

${formatHistory(history)}

---

Do you want to speak? If yes, write your contribution now. If not, reply with exactly: PASS`;

  return callCharacter(systemPrompt, userPrompt);
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

async function callCharacter(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ wantsToSpeak: boolean; message: string }> {
  if (webSearchEnabled) {
    return callCharacterWithSearch(systemPrompt, userPrompt);
  }
  return callCharacterPlain(systemPrompt, userPrompt);
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

  if (webSearchEnabled) await checkDuckDuckGoAvailable();

  print("\n🎙  WORKSHOP SIMULATOR");
  print("=".repeat(70));
  print("You are the facilitator. Characters will decide when to speak.");
  print("Type 'quit' at any prompt to end the workshop.\n");
  print(`Participants: ${characters.map((c) => c.name).join(", ")}`);
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
    print("⏳  Checking who wants to speak...\n");

    // Ask all characters whether they want to speak this round.
    const decisions = await Promise.all(
      characters.map(async (character) => {
        const result = await askCharacterToDecide(character, history);
        const turnsWaiting = waitingTurns.get(character.name) ?? 0;
        const updated: SpeakDecision = {
          character,
          wantsToSpeak: result.wantsToSpeak,
          message: result.message,
          turnsWaiting: result.wantsToSpeak ? turnsWaiting + 1 : 0,
        };
        waitingTurns.set(character.name, updated.wantsToSpeak ? turnsWaiting + 1 : 0);
        return updated;
      }),
    );

    pendingDecisions = decisions.filter((d) => d.wantsToSpeak);

    if (pendingDecisions.length === 0) {
      // Nobody wants to speak — facilitator must say something
      print("💬  No participants want to speak. The facilitator must continue.\n");
      const facilitatorInput = await ask("Facilitator: ");
      if (facilitatorInput.toLowerCase() === "quit") break;
      history.push({ speaker: "Facilitator", message: facilitatorInput });
      continue;
    }

    // Show facilitator who is waiting
    print("🙋  The following participants want to speak:\n");
    pendingDecisions.forEach((d, i) => {
      const waitLabel =
        d.turnsWaiting > 1
          ? ` (waiting ${d.turnsWaiting} turn${d.turnsWaiting > 1 ? "s" : ""})`
          : "";
      print(`  ${i + 1}. ${d.character.name}${waitLabel}`);
    });

    print("\nOptions:");
    print("  • Enter a number to call on that participant");
    print("  • Type your own statement to speak as facilitator first");
    print("  • Type 'quit' to end the workshop");
    print("");

    const facilitatorInput = await ask("Facilitator: ");
    if (facilitatorInput.toLowerCase() === "quit") break;

    const choiceNum = parseInt(facilitatorInput, 10);
    const calledDecision =
      !isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= pendingDecisions.length
        ? pendingDecisions[choiceNum - 1]
        : null;

    if (calledDecision) {
      // Facilitator calls on a character
      print(`\n→ ${calledDecision.character.name} speaks:\n`);
      print(calledDecision.message);
      history.push({
        speaker: calledDecision.character.name,
        message: calledDecision.message,
      });
      // Reset that character's waiting counter
      waitingTurns.set(calledDecision.character.name, 0);
    } else {
      // Facilitator chose to speak themselves
      history.push({ speaker: "Facilitator", message: facilitatorInput });
      print(`\n→ Facilitator: ${facilitatorInput}`);
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
