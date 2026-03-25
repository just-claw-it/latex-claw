// Strip LaTeX markup for use in external API queries.
// The raw BibTeX title {A Survey of {LLM}-based {Agents}} should query as:
//   A Survey of LLM-based Agents

const ACCENT_MAP: Record<string, string> = {
  "\\'a": "a", "\\'e": "e", "\\'i": "i", "\\'o": "o", "\\'u": "u",
  "\\'A": "A", "\\'E": "E", "\\'I": "I", "\\'O": "O", "\\'U": "U",
  '\\"a': "a", '\\"e': "e", '\\"o': "o", '\\"u': "u",
  '\\"A': "A", '\\"E': "E", '\\"O': "O", '\\"U': "U",
  "\\`a": "a", "\\`e": "e", "\\`i": "i", "\\`o": "o",
  "\\^a": "a", "\\^e": "e", "\\^i": "i", "\\^o": "o",
  "\\~n": "n", "\\~N": "N",
  "\\c{c}": "c", "\\c{C}": "C",
  "--": "-", "---": "-",
};

export function stripLatex(input: string): string {
  let s = input;

  // Apply accent map
  for (const [from, to] of Object.entries(ACCENT_MAP)) {
    s = s.split(from).join(to);
  }

  // \emph{content}, \textbf{content}, etc → content
  s = s.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, "$1");

  // Remaining bare braces
  s = s.replace(/[{}]/g, "");

  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}
