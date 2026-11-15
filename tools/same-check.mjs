// The apps wear Instant Wallet's look (instant-wallet EXPECTATIONS.md #2). Seconds, no browser.
// Run: node tools/same-check.mjs   (with ../instant-wallet next to this repo, it also compares the colors and parts)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const SHARED = "src/ui.tsx"; // the one file that draws a button or a box
let bad = 0;
const fail = m => (bad++, console.log(m));

const RULES = [
  { re: /<button\b/, say: "a button drawn by hand: use <Go> (green), <White>, <Tabs>, <Row> or <Box pill>" },
  { re: /<input\b/, say: "a text box drawn by hand: use <Box> (the wallet's recessed .input)" },
  { re: /className="[^"]*\b(ghost|muted|bad|small|shrink)\b/, say: "an old class: .fine (small gray), .err (red), .good (green)" },
  { re: /Confirm|Approve\b(?!\()/, say: "never Confirm / Approve on a signature: <Go> says 'Sign in your wallet…'" },
  { re: /"(Deposited|Withdrawn|Repaid|Staked|Unstaked|Claimed|Done)\."/, say: "a tx that ran says ✓ Executed: <Result>" },
  { re: /CHAIN_NAME|\bon (Base|Ethereum)\b(?!\. Switch| forks?)/, say: "a network named by hand: use <Net> (logo, then name)" },
  { re: />[^<{]*\btokens?\b[^<{]*</, say: "'token' in words a user reads: say 'coin'" },
  { re: /#[0-9a-fA-F]{3,8}\b|rgba?\(/, say: "a color written by hand: use the wallet's (var(--mint-d), var(--coral), var(--muted))" },
];

const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) files.push(p);
  }
})(join(root, "src"));
for (const p of files) {
  const rel = relative(root, p);
  if (rel === SHARED) continue;
  readFileSync(p, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
      for (const r of RULES) if (r.re.test(line)) fail(`${rel}:${i + 1}  ${r.say}`);
    });
}

// the colors and the parts are the wallet's, to the letter
const wallet = join(root, "../instant-wallet/web/app/globals.css");
if (existsSync(wallet)) {
  const rules = css => {
    const out = new Map();
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, " ");
      if (!sel.startsWith("@")) out.set(sel, (out.get(sel) ?? "") + m[2].replace(/\s+/g, " ").trim());
    }
    return out;
  };
  const theirs = rules(readFileSync(wallet, "utf8"));
  const css = readFileSync(join(root, "src/style.css"), "utf8");
  const ours = rules(css.split("/* ---- the apps' own layout")[0]);
  for (const [sel, body] of ours) {
    if (!theirs.has(sel)) fail(`src/style.css  ${sel} is not one of the wallet's parts: layout goes under "the apps' own layout"`);
    else if (sel === ":root" || sel === 'html[data-brand="xdai"]') {
      const vars = b => new Map([...b.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(x => [x[1], x[2]]));
      const t = vars(theirs.get(sel));
      for (const [k, v] of vars(body)) if (k !== "--font" && t.get(k) !== v) fail(`src/style.css  ${k} differs from the wallet's (${t.get(k)})`);
    } else if (!theirs.get(sel).includes(body)) fail(`src/style.css  ${sel} differs from the wallet's`);
  }
  const own = css.split("/* ---- the apps' own layout")[1] ?? "";
  if (/box-shadow|border-radius|gradient\(|#[0-9a-fA-F]{3,8}\b/.test(own.replace(/\.asset\.on \{[^}]*\}/, ""))) fail("src/style.css  the apps' own layout draws a part (a shadow, a radius, a color): copy the wallet's instead");
} else console.log("(../instant-wallet not here: colors and parts not compared)");

console.log(bad ? `\n${bad} place(s) don't look like Instant Wallet` : "same-check: all good");
process.exit(bad ? 1 : 0);
