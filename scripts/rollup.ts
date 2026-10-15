// Rolls the verdict.json files of one run (or of the whole results/ folder) into a markdown
// comparison table. Node ≥ 22 runs this directly (type stripping) — no build step.
//
//   node scripts/rollup.ts results > results-<date>.md                  (local flat files)
//   node scripts/rollup.ts <results-dir>/<run-id> > results-<date>.md   (container layout)
import { readdirSync, readFileSync, existsSync, createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";

type TagStat = { p95?: number; p99?: number; max?: number; count?: number };
type Verdict = {
  scenario: string; runId?: string; round: number; requests?: number; rps?: number; p95?: number; p99?: number; max?: number;
  errRate?: number; slowRate?: number; slowCount?: number; pass: boolean; failedThresholds: string[]; perTag: Record<string, TagStat>;
  endpoint?: string; mode?: "target" | "ladder" | "check"; capacityRps?: number; prepFailed?: number; dropped?: number;
  targetRps?: number; targetFloor?: number; targetMet?: boolean;
  steps?: { phase: string; offered: number; achieved: number; count: number; p95?: number; p99?: number; max?: number; errRate: number; slowCount?: number; slowRate?: number; pass: boolean }[];
};

// ---- One-second peak (from raw output next to the verdict, when present) ---------------------
type Peak = { peak: number; byPhase: Record<string, number>; source: string };
const peakFromLive = (file: string): Peak => {
  const series: { n: number; ph?: string }[] = JSON.parse(readFileSync(file, "utf8")).series ?? [];
  const byPhase: Record<string, number> = {};
  let peak = 0;
  for (const s of series) { peak = Math.max(peak, s.n); if (s.ph) byPhase[s.ph] = Math.max(byPhase[s.ph] ?? 0, s.n); }
  return { peak, byPhase, source: path.basename(file) };
};
const peakFromRaw = async (file: string): Promise<Peak> => {
  const input = file.endsWith(".gz") ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  const perSec = new Map<string, number>(), perPhaseSec = new Map<string, number>();
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.includes('"metric":"http_reqs"') || !line.includes('"type":"Point"')) continue;
    const d = JSON.parse(line).data;
    const sec = String(d.time).slice(0, 19);
    perSec.set(sec, (perSec.get(sec) ?? 0) + d.value);
    const ph = d.tags?.phase;
    if (ph) perPhaseSec.set(`${ph} ${sec}`, (perPhaseSec.get(`${ph} ${sec}`) ?? 0) + d.value);
  }
  const byPhase: Record<string, number> = {};
  for (const [k, n] of perPhaseSec) { const ph = k.split(" ")[0]; byPhase[ph] = Math.max(byPhase[ph] ?? 0, n); }
  return { peak: Math.max(0, ...perSec.values()), byPhase, source: path.basename(file) };
};
const peakFor = async (verdictFile: string, v: Verdict): Promise<Peak | undefined> => {
  const dir = path.dirname(verdictFile);
  const candidates = [path.join(dir, "raw.json.gz"), path.join(dir, "raw.json"), ...(v.runId ? [path.join(dir, `${v.runId}_raw.json.gz`), path.join(dir, `${v.runId}_raw.json`)] : [])];
  for (const f of candidates) if (existsSync(f)) return peakFromRaw(f);
  const live = v.runId ? path.join(dir, `${v.runId}_live.json`) : "";
  return live && existsSync(live) ? peakFromLive(live) : undefined;
};

const runDir = process.argv[2];
if (!runDir || !existsSync(runDir)) { console.error("usage: node scripts/rollup.ts <results-dir>[/<run-id>]"); process.exit(2); }

const ms = (v?: number) => (v === undefined || v === null ? "—" : v.toFixed(1));
const pct = (v?: number) => (v === undefined || v === null ? "—" : `${(v * 100).toFixed(3)} %`);
const n1 = (v?: number) => (v === undefined ? "—" : String(v));
const findVerdicts = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => { const p = path.join(dir, e.name); if (e.isDirectory()) return findVerdicts(p); return e.name.endsWith("verdict.json") ? [p] : []; });

const main = async () => {
  const files = findVerdicts(runDir);
  const verdicts = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as Verdict);
  const peaks = new Map<Verdict, Peak | undefined>();
  for (let i = 0; i < files.length; i++) peaks.set(verdicts[i], await peakFor(files[i], verdicts[i]));
  const byScenario = new Map<string, Verdict[]>();
  for (const v of verdicts) byScenario.set(v.scenario, [...(byScenario.get(v.scenario) ?? []), v]);
  const out: string[] = [`# pmc-line perf results — ${path.basename(runDir)}`, ""];
  for (const [scenario, rounds] of [...byScenario].sort()) {
    rounds.sort((a, b) => (a.runId ?? "").localeCompare(b.runId ?? "") || a.round - b.round);
    out.push(`## ${scenario.toUpperCase()}`, "");
    out.push("| Run | Round | Row | Verdict | requests | avg TPS | peak 1 s TPS | err rate | > slow gate | p95 ms | p99 ms | max ms | target TPS |");
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of rounds) {
      out.push(`| ${r.runId ?? "—"} | ${r.round} | ${r.endpoint ?? "ALL"} | ${r.pass ? "PASS" : "**FAIL**"} | ${r.requests ?? "—"} | ${r.rps?.toFixed(1) ?? "—"} | ${n1(peaks.get(r)?.peak)} | ${pct(r.errRate ?? undefined)} | ${pct(r.slowRate ?? undefined)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} | ${r.targetRps ?? "—"} |`);
    }
    out.push("");
    const tags = [...new Set(rounds.flatMap((r) => Object.keys(r.perTag ?? {})))].sort();
    if (tags.length) {
      out.push("| Tag | worst p95 ms | worst p99 ms | worst max ms |", "|---|---|---|---|");
      for (const t of tags) {
        const worst = (k: keyof TagStat) => Math.max(...rounds.map((r) => r.perTag?.[t]?.[k] ?? 0));
        const p95 = worst("p95");
        out.push(`| \`${t}\` | ${p95 > 300 ? `**${ms(p95)}**` : ms(p95)} | ${ms(worst("p99"))} | ${ms(worst("max"))} |`);
      }
      out.push("");
    }
    for (const r of rounds.filter((x) => x.steps)) {
      out.push(`**${r.endpoint}**, ${r.mode}${r.mode === "ladder" ? `, capacity within gate: **${r.capacityRps} TPS**` : ""} (run ${r.runId}; prep failures ${r.prepFailed ?? 0}; dropped iterations ${r.dropped ?? 0})`, "",
        "| Step | offered TPS | achieved TPS | peak 1 s TPS | n | p95 ms | p99 ms | max ms | err rate | > slow gate | step |", "|---|---|---|---|---|---|---|---|---|---|---|");
      for (const st of r.steps!) {
        const slow = st.slowCount === undefined ? "—" : `${st.slowCount} (${pct(st.slowRate)})`;
        out.push(`| ${st.phase} | ${st.offered} | ${st.achieved.toFixed(1)} | ${n1(peaks.get(r)?.byPhase[st.phase])} | ${st.count} | ${ms(st.p95)} | ${ms(st.p99)} | ${ms(st.max)} | ${pct(st.errRate)} | ${slow} | ${st.pass ? "PASS" : "**FAIL**"} |`);
      }
      out.push("");
    }
    const failed = rounds.filter((r) => !r.pass);
    if (failed.length) { out.push("Failed thresholds:", ""); for (const r of failed) out.push(`- ${r.runId} round ${r.round}: ${(r.failedThresholds ?? []).join(", ")}`); out.push(""); }
  }
  console.log(out.join("\n"));
};
main().catch((e) => { console.error(e); process.exit(1); });
