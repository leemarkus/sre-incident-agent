/** CommonMark §2.1: CRLF is one ending; lone CR and LF also end lines. */
export const MARKDOWN_LINE_END = /\r\n|\r|\n/;

/** A line's role in a fenced code block; delimiters belong to the block. */
export type FenceLine =
  | { kind: "open"; info: string }
  | { kind: "body" | "close" | "prose" };

type Container = { kind: "quote" } | { kind: "list"; width: number };

/**
 * CommonMark §4.5 fences inside §5 containers. Indentation is relative to each
 * list content column / quote prefix, with tabs advancing to four-column stops.
 * This is not a full block parser: lazy paragraph continuations retain container
 * context until a blank or block-start line; HTML blocks and indented code are
 * left to consumers. Lazy continuation never extends a fenced code block.
 */
export class FenceScanner {
  private marker = "";
  private length = 0;
  private containers: Container[] = [];
  private blank = true;

  get inFence(): boolean {
    return this.length !== 0;
  }

  next(line: string): FenceLine {
    // Direct line callers may leave CR from CRLF; whole-text callers split §2.1.
    const raw = line.replace(/\r$/, "");
    // Expand tabs only in container furniture, using document columns even
    // after `>` or another list marker. Leave info strings and body bytes alone.
    let column = 0;
    let rest = raw.replace(/^[ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])[ \t]*)*/, (prefix) =>
      [...prefix].map((c) => {
        const width = c === "\t" ? 4 - column % 4 : 1;
        column += width;
        return c === "\t" ? " ".repeat(width) : c;
      }).join(""));
    let kept = 0;
    for (const container of this.containers) {
      if (container.kind === "quote") {
        const prefix = /^ {0,3}>[ \t]?/.exec(rest);
        if (!prefix) break;
        rest = rest.slice(prefix[0].length);
      } else if (rest.trim() === "") {
        rest = "";
      } else if (rest.startsWith(" ".repeat(container.width))) {
        rest = rest.slice(container.width);
      } else break;
      kept += 1;
    }
    if (kept < this.containers.length) {
      const blockStart = /^ {0,3}(?:>|[-+*](?:\s|$)|\d{1,9}[.)](?:\s|$)|#{1,6}(?:\s|$)|`{3,}|~{3,})/s.test(rest);
      if (!this.inFence && !this.blank && rest.trim() !== "" && !blockStart) {
        return { kind: "prose" };
      }
      this.containers.length = kept;
      this.length = 0;
      this.marker = "";
    }
    if (!this.inFence) {
      for (;;) {
        const quote = /^ {0,3}>[ \t]?/.exec(rest);
        if (quote) {
          this.containers.push({ kind: "quote" });
          rest = rest.slice(quote[0].length);
          continue;
        }
        const item = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(rest);
        if (!item) break;
        const markerWidth = item[1]!.length + item[2]!.length;
        let width = markerWidth;
        for (const c of item[3]!) width += c === "\t" ? 4 - width % 4 : 1;
        const padding = width - markerWidth;
        // §5.2: >4 spaces after the marker uses one space of item padding.
        const used = padding >= 1 && padding <= 4 ? padding : 1;
        this.containers.push({ kind: "list", width: markerWidth + used });
        rest = " ".repeat(Math.max(0, padding - used)) + rest.slice(item[0].length);
      }
    }
    this.blank = rest.trim() === "";
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/s.exec(rest);
    const run = match?.[1] ?? "";
    const info = match?.[2] ?? "";
    if (this.inFence) {
      if (run[0] === this.marker && run.length >= this.length && /^[ \t]*$/.test(info)) {
        this.length = 0;
        this.marker = "";
        return { kind: "close" };
      }
      return { kind: "body" };
    }
    if (match === null || (run[0] === "`" && info.includes("`"))) {
      return { kind: "prose" };
    }
    this.marker = run[0]!;
    this.length = run.length;
    return { kind: "open", info: info.trim() };
  }
}

/** Blank fenced lines, preserving prose and line positions for every consumer. */
export function defenced(text: string): string {
  const fence = new FenceScanner();
  return text
    .split(MARKDOWN_LINE_END)
    .map((line) => fence.next(line).kind === "prose" ? line : "")
    .join("\n");
}
