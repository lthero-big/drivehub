// Read-only code viewer (DEPTAI-485 r3 #4): language by extension / file name, highlight.js,
// line numbers (CSS counters, not copied), wrap toggle, copy, manual language override.
import { useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import { Check, Copy, WrapText } from "lucide-react";
import { ext } from "../lib/util";
import { Select, toast } from "../ui/ui";
import { cx } from "../lib/util";

const BY_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", mts: "typescript",
  py: "python", pyw: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", sh: "bash", bash: "bash", zsh: "bash", fish: "bash", json: "json", jsonc: "json", json5: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini", cfg: "ini", env: "ini", properties: "ini",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", xhtml: "xml", plist: "xml", css: "css", scss: "scss", sass: "scss", less: "less", sql: "sql", md: "markdown", markdown: "markdown",
  php: "php", rb: "ruby", swift: "swift", lua: "lua", pl: "perl", pm: "perl", r: "r", m: "objectivec", mm: "objectivec", diff: "diff", patch: "diff", mk: "makefile", gql: "graphql", graphql: "graphql", wat: "wasm", vb: "vbnet", txt: "plaintext", log: "plaintext",
};
const BY_NAME: Record<string, string> = { dockerfile: "bash", makefile: "makefile", gnumakefile: "makefile", ".bashrc": "bash", ".zshrc": "bash", ".gitignore": "ini", ".env": "ini", cmakelists: "makefile" };
const LABEL: Record<string, string> = { plaintext: "纯文本", cpp: "C++", csharp: "C#", objectivec: "Objective-C", xml: "HTML/XML", ini: "INI/TOML", javascript: "JavaScript", typescript: "TypeScript", bash: "Shell", vbnet: "VB.NET", php: "PHP", sql: "SQL", css: "CSS", scss: "SCSS", json: "JSON", yaml: "YAML", wasm: "WebAssembly", graphql: "GraphQL" };
export const langLabel = (l: string) => LABEL[l] ?? l.charAt(0).toUpperCase() + l.slice(1);

export function detectLang(name: string): string {
  const low = name.toLowerCase();
  return BY_NAME[low] ?? BY_EXT[ext(name)] ?? "plaintext";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Splits highlighted HTML into lines, closing and re-opening spans across line breaks. */
export function splitLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const m of html.matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+|</g)) {
    const t = m[0];
    if (t === "\n") {
      out.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else if (t === "</span>") {
      open.pop();
      cur += t;
    } else if (t.startsWith("<span")) {
      open.push(t);
      cur += t;
    } else cur += t;
  }
  out.push(cur + "</span>".repeat(open.length));
  return out;
}

const HL_MAX = 400 * 1024;

export function CodeViewer({ name, text, truncated }: { name: string; text: string; truncated?: boolean }) {
  const auto = useMemo(() => detectLang(name), [name]);
  const [lang, setLang] = useState<string>(auto);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const langs = useMemo(() => ["plaintext", ...hljs.listLanguages().filter((l) => l !== "plaintext").sort()], []);
  const lines = useMemo(() => {
    let html: string;
    if (lang === "plaintext" || text.length > HL_MAX || !hljs.getLanguage(lang)) html = esc(text);
    else {
      try {
        html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } catch {
        html = esc(text);
      }
    }
    return splitLines(html);
  }, [text, lang]);
  const body = useMemo(() => lines.map((l) => `<span class="cl">${l || " "}</span>`).join(""), [lines]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    toast.ok("代码已复制");
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel-2" data-code-viewer data-lang={lang}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs text-muted">
        <span className="rounded-md bg-accent-soft px-2 py-0.5 font-medium text-accent" data-testid="code-lang">{langLabel(lang)}</span>
        {lang !== auto && <button className="underline hover:text-fg" onClick={() => setLang(auto)}>恢复自动（{langLabel(auto)}）</button>}
        <span>{lines.length} 行</span>
        <span className="ml-auto flex items-center gap-1">
          <Select value={lang} onChange={(e) => setLang(e.target.value)} size="xs" aria-label="语言">
            {langs.map((l) => <option key={l} value={l}>{langLabel(l)}</option>)}
          </Select>
          <button aria-pressed={wrap} onClick={() => setWrap(!wrap)} className={cx("flex h-7 items-center gap-1 rounded-md border border-line px-2 hover:bg-hover", wrap && "bg-active text-fg")}>
            <WrapText className="size-3.5" /> 换行
          </button>
          <button onClick={copy} className="flex h-7 items-center gap-1 rounded-md border border-line px-2 hover:bg-hover">
            {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />} 复制
          </button>
        </span>
      </div>
      <pre className={cx("code-pre scroll-thin min-h-0 flex-1 overflow-auto py-2 font-mono text-[12.5px] leading-5", wrap && "code-wrap")} dangerouslySetInnerHTML={{ __html: body }} />
      {truncated && <p className="shrink-0 border-t border-line p-2 text-xs text-warn">文件较大，只显示前 1 MB。</p>}
    </div>
  );
}
