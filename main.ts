// Token Radar, a token-radar-01 entry (Node 22, standard library only).
//
// 1. Read the sealed snapshot (/input/snapshot.json, or --input <file|dir>).
// 2. Run dashboard/model.js, the same script the page runs, in a node:vm context: it calibrates the
//    category multiples on the snapshot's trading protocols, scores every pre-token protocol, and writes
//    each one's farm plan.
// 3. Refuse a board the gate would refuse, then write /output/board.json, /output/data.js (the snapshot
//    the page re-scores with the same model), dashboard/, screenshots/ and, last, dossier.json.
//
// Outside the grader: MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const MAX_IMPLIED = 100_000_000_000_000;

interface Protocol {
  slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number;
  change_7d: number | null; mcap_usd: number | null; listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
interface Snapshot { as_of: string; source: string; floor_usd: number; protocols: Protocol[]; watchlist: string[] }
interface Row { rank: number; slug: string; name: string; implied_value_usd: number; farm_steps: string[]; [k: string]: unknown }
interface Radar { rows: Row[]; digest: string; calibration: { n: number; elasticity: number; validation: { model: number; starter_quarter: number } }; [k: string]: unknown }

function fail(message: string, code = 1): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

/** The snapshot, held to the ten-field shape the model reads; anything else is refused by name. */
function readSnapshot(file: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail(`${file} is not JSON`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o !== 'object' || o === null || !Array.isArray(o.protocols) || !Array.isArray(o.watchlist)) fail('the snapshot has no protocols or watchlist');
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) fail('the snapshot has no as_of date');
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const protocols = (o.protocols as Record<string, unknown>[]).map((p, i) => {
    if (typeof p?.slug !== 'string' || typeof p.name !== 'string' || num(p.tvl_usd) === null) fail(`protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug, name: p.name, category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: num(p.tvl_usd)!, change_7d: num(p.change_7d), mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at), gecko_id: str(p.gecko_id), symbol: str(p.symbol),
    };
  });
  return {
    as_of: o.as_of, source: typeof o.source === 'string' ? o.source : '', floor_usd: num(o.floor_usd) ?? 50_000_000,
    protocols, watchlist: (o.watchlist as unknown[]).filter((s): s is string => typeof s === 'string'),
  };
}

/** The radar, from the page's own model script: one implementation, two hosts. */
function runModel(snapshot: Snapshot): Radar {
  const source = readFileSync(join(here, 'dashboard', 'model.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: 'dashboard/model.js' });
  const api = sandbox.RadarModel as { buildRadar: (s: Snapshot) => Radar } | undefined;
  if (api === undefined) fail('dashboard/model.js did not define RadarModel');
  // A JSON round trip leaves the vm's realm behind: plain objects, the bytes board.json will hold.
  return JSON.parse(JSON.stringify(api.buildRadar(JSON.parse(JSON.stringify(snapshot)))));
}

/** Why the gate would refuse this board, or null. Mirrors the gate's rows: coverage, ranks, order, steps. */
function boardIssue(rows: Row[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `${rows.length} rows: the gate takes 100 to 4,000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of rows) {
    if (!known.has(r.slug)) return `${r.slug} is not in the snapshot`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (/\s/.test(r.slug) || r.name.trim() === '') return `${r.slug} has a bad slug or name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > MAX_IMPLIED) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) return `${r.slug} has a farm step of ${n} characters`;
    }
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is missing`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} is worth more than rank ${i}`;
  }
  if (byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'every row has the same implied value';
  return null;
}

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory>`, 2);
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = readSnapshot(inputFile);
const radar = runModel(snapshot);
const issue = boardIssue(radar.rows, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ model: radar.model, as_of: snapshot.as_of, rows: radar.rows })}\n`);
// The page re-runs the model on the snapshot itself, so data.js carries the input, not the answer.
// BOARD_DIGEST lets the page prove it shows the same board: it recomputes the digest and compares.
writeFileSync(join(out, 'data.js'), `window.SNAPSHOT=${JSON.stringify(snapshot)};\nwindow.BOARD_DIGEST=${JSON.stringify(radar.digest)};\n`);

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view`);

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const tiers = (t: string): number => radar.rows.filter((r) => r.tier === t).length;
const cal = radar.calibration;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${radar.rows.length} pre-token rows ranked ` +
    `(${tiers('off-list')} off-list above the floor, ${tiers('early')} early below it)\n` +
    `token radar: calibrated on ${cal.n} trading tokens: value ~ TVL^${cal.elasticity}, held-out error ${cal.validation.model}x (flat 0.25 x TVL: ${cal.validation.starter_quarter}x)\n` +
    `token radar: wrote board.json, data.js, dashboard/, screenshots/ (${shots.length}) and dossier.json to ${out}\n`,
);
