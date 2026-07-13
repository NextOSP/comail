import { Fragment, type ReactNode } from "react";

// A deliberately tiny, dependency-free Markdown renderer for AI answers. It
// builds React elements (never dangerouslySetInnerHTML) so untrusted model
// output can't inject HTML. Supports the small subset models actually emit:
// paragraphs, bullet/numbered lists, **bold**, *italic*, `code`, [links](url),
// and #-headings (rendered as emphasized lines). Anything unrecognized falls
// through as plain text.

/** Render inline spans: bold, italic, inline code, and links. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Ordered by how we want to match; each capture group is the payload.
  const pattern =
    /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+?)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[2] !== undefined) {
      nodes.push(<strong key={key}>{m[2]}</strong>);
    } else if (m[4] !== undefined) {
      nodes.push(<em key={key}>{m[4]}</em>);
    } else if (m[5] !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-bg2 px-1 py-0.5 text-[0.85em]">
          {m[5]}
        </code>,
      );
    } else if (m[6] !== undefined && m[7] !== undefined) {
      nodes.push(
        <a
          key={key}
          href={m[7]}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline"
        >
          {m[6]}
        </a>,
      );
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface Block {
  type: "p" | "h" | "ul" | "ol";
  lines: string[];
}

/** Group raw text into paragraph / heading / list blocks. */
function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      blocks.push({ type: "h", lines: [line.replace(/^#{1,6}\s+/, "")] });
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul) {
      if (!cur || cur.type !== "ul") {
        flush();
        cur = { type: "ul", lines: [] };
      }
      cur.lines.push(ul[1]);
      continue;
    }
    if (ol) {
      if (!cur || cur.type !== "ol") {
        flush();
        cur = { type: "ol", lines: [] };
      }
      cur.lines.push(ol[1]);
      continue;
    }
    if (!cur || cur.type !== "p") {
      flush();
      cur = { type: "p", lines: [] };
    }
    cur.lines.push(line);
  }
  flush();
  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        if (b.type === "h") {
          return (
            <p key={i} className="mb-2 mt-3 font-semibold first:mt-0">
              {renderInline(b.lines[0], `h${i}`)}
            </p>
          );
        }
        if (b.type === "ul" || b.type === "ol") {
          const List = b.type === "ul" ? "ul" : "ol";
          return (
            <List
              key={i}
              className={`mb-2 ml-5 flex flex-col gap-1 ${
                b.type === "ul" ? "list-disc" : "list-decimal"
              }`}
            >
              {b.lines.map((li, j) => (
                <li key={j}>{renderInline(li, `l${i}-${j}`)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className="mb-2 last:mb-0">
            {b.lines.map((ln, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(ln, `p${i}-${j}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
