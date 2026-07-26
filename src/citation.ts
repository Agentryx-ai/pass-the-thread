// Codex's memory citations, and why they cannot be carried across as citations.
//
// When Codex answers using its memory files it is instructed to append one
// `<oai-mem-citation>` block as the very last thing in the reply — the
// instruction in the rollout says "Use this exact structure for programmatic
// parsing". Codex Desktop parses that envelope back out and renders it as
// citation UI, so the tags are never on screen. It is not a rollout item type:
// it arrives as ordinary text inside an assistant `output_text` block.
//
// Claude has nothing to convert it into. Its transcripts carry no citation
// field (the line schema is firstPrompt / agentName / customTitle / aiTitle /
// summary / lastPrompt / gitBranch / relocated / isSidechain), and the
// `citations` array the Anthropic API puts on text blocks has no renderer in
// Claude Code — in the bundled 2.1.219 build the word appears only in Bedrock
// model definitions and in bundled API documentation. Left inline, the envelope
// is simply text in the middle of the conversation.
//
// So it is treated the way this tool treats everything else that is real
// content authored by neither side: lifted out of the message and re-emitted as
// a readable `isMeta` line, the same shape sub-agent reports get.
const BLOCK = /<oai-mem-citation>([\s\S]*?)<\/oai-mem-citation>/g;
const SECTION = (name: string): RegExp =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
/** `MEMORY.md:46-53|note=[evidence artifact handling context]` */
const ENTRY = /^(.*?)\|note=\[([\s\S]*)\]$/;

export interface SplitCitations {
  /** The reply with the citation envelopes removed. */
  body: string;
  /** One readable summary per envelope found, in order. */
  citations: string[];
}

/** Separate Codex's memory citations from what the assistant actually said. */
export function splitCitations(text: string): SplitCitations {
  if (!text.includes("<oai-mem-citation>")) return { body: text, citations: [] };
  const citations: string[] = [];
  const body = text
    .replace(BLOCK, (_match, inner: string) => {
      const rendered = renderCitation(inner);
      if (rendered !== "") citations.push(rendered);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, citations };
}

/** Turn one envelope's contents into something a person can read. */
export function renderCitation(inner: string): string {
  const lines: string[] = [];

  const entries = SECTION("citation_entries").exec(inner)?.[1] ?? "";
  for (const raw of entries.split(/\r?\n/)) {
    const entry = raw.trim();
    if (entry === "") continue;
    const m = ENTRY.exec(entry);
    lines.push(m ? `  ${m[1].trim()} — ${m[2].trim()}` : `  ${entry}`);
  }

  const ids = SECTION("rollout_ids").exec(inner)?.[1] ?? "";
  for (const raw of ids.split(/\r?\n/)) {
    const id = raw.trim();
    if (id === "") continue;
    lines.push(`  conversation ${id}`);
  }

  // An envelope with neither section carries nothing worth a line of its own.
  if (lines.length === 0) return "";
  return `[pass-the-thread] Codex cited its memory here:\n${lines.join("\n")}`;
}
