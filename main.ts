// btc-cent-forecast-01 entry: a damped mean-reversion forecaster for BTC/USDC.
//
// Idea, in one paragraph: over a 4-hour horizon the 1-minute BTC close
// mean-reverts toward its trailing 24-hour level and against its own
// trailing 4-hour move. The program therefore forecasts the log-return
// over the next 240 minutes as a small, fixed pull toward the 24-hour
// mean of log prices plus a small pull against the last 240-minute
// log-return, then exponentiates back to a price. Both pulls are
// deliberately weak (0.30 and 0.15) and the total adjustment is capped,
// because at this horizon most of the move is unpredictable noise and
// an aggressive forecast would lose to simply guessing "no change".
//
// Why these numbers: they were chosen on walk-forward backtests run
// inside the practice cases only (checkpoints every 2 and 4 hours,
// each forecast made from prices available up to that checkpoint and
// scored against the price 240 minutes later). On those grids the
// forecaster's mean absolute error was about 0.91-0.93x the error of
// guessing the checkpoint close, winning in 5-6 of the 6 practice
// windows. Momentum in the same direction (positive weight on the
// trailing 4-hour return) made things worse on every grid, and a
// fitted multi-feature regression was unstable, so the program fits
// nothing at run time: the two weights are constants, which also makes
// the output exactly reproducible.
//
// Run: node main.ts, with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// standing in for /input and /output outside the grader.
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
//
// I/O contract (kit): read every <id>.in in the input directory,
// write <id>.out to the output directory as
// {"forecasts":[{"case":"<id>","price":<number>}]}, exactly one row,
// price finite, > 0, < 10,000,000, on the 5-decimal grid.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

/** Minutes of history the anchor average covers: one full day. */
const ANCHOR_MINUTES = 1440;
/** Minutes of the recent move the forecast leans against. */
const RECENT_MINUTES = 240;
/** Pull toward the 24-hour mean of log prices (per unit log-distance). */
const ANCHOR_PULL = 0.3;
/** Pull against the trailing 4-hour log-return (per unit log-return). */
const RECENT_PULL = 0.15;
/** Hard cap on the forecast log-return, so one wild stretch of history
 *  can never throw the guess far from the checkpoint close. */
const MAX_LOG_MOVE = 0.025;

/** Smallest / largest price the scorer accepts, on the 5-decimal grid. */
const MIN_PRICE = 0.00001;
const MAX_PRICE = 9_999_999.99999;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface CaseFile {
  markets: CaseMarket[];
}

/** Clamp a raw price onto the scorer's grid and range. */
function gridPrice(x: number): number {
  const clamped = Math.min(MAX_PRICE, Math.max(MIN_PRICE, x));
  return Math.round(clamped * 1e5) / 1e5;
}

/** Arithmetic mean of arr[lo..hi] inclusive; indexes are already valid. */
function meanOf(arr: number[], lo: number, hi: number): number {
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += arr[i] as number;
  return sum / (hi - lo + 1);
}

/**
 * Forecast the close 240 minutes after the checkpoint.
 * prices: closes, one a minute, last entry = close at the checkpoint.
 * Returns the forecast price, on the grid.
 */
function forecast(prices: number[]): number {
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error("market has no prices");
  }
  const last = prices[prices.length - 1] as number;
  if (typeof last !== "number" || !Number.isFinite(last) || last <= 0) {
    throw new Error("last price is not a finite positive number");
  }

  // Work in logs: returns add, and a proportional pull is scale-free.
  const n = prices.length;

  // Validate every close we will take a log of: one bad tick (0,
  // negative, NaN) would otherwise poison the whole forecast to NaN
  // and emit a non-finite price the scorer rejects. Fail loudly
  // instead, naming the bad index.
  for (let i = 0; i < n; i++) {
    const p = prices[i] as number;
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
      throw new Error(`price at index ${i} is not a finite positive number`);
    }
  }

  const logLast = Math.log(last);

  // Anchor: mean log price over the trailing day (or all history if
  // the case is shorter than a day). Deviation above the anchor pulls
  // the forecast down, below it pulls it up.
  const anchorSpan = Math.min(ANCHOR_MINUTES, n);
  let anchorSum = 0;
  for (let i = n - anchorSpan; i < n; i++) anchorSum += Math.log(prices[i] as number);
  const anchor = anchorSum / anchorSpan;
  const deviation = logLast - anchor;

  // Recent move: log-return over the trailing 4 hours (or all history
  // if shorter). A recent rise pulls the forecast down, a recent fall
  // pulls it up — the opposite of trend-following.
  let recentReturn = 0;
  if (n > 1) {
    const back = Math.min(RECENT_MINUTES, n - 1);
    recentReturn = logLast - Math.log(prices[n - 1 - back] as number);
  }

  let logMove = -ANCHOR_PULL * deviation - RECENT_PULL * recentReturn;
  if (logMove > MAX_LOG_MOVE) logMove = MAX_LOG_MOVE;
  if (logMove < -MAX_LOG_MOVE) logMove = -MAX_LOG_MOVE;

  return gridPrice(last * Math.exp(logMove));
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith(".in")).sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as CaseFile;
  if (!Array.isArray(c.markets) || c.markets.length !== 1) {
    throw new Error(`${file} does not hold exactly one market`);
  }
  const market = c.markets[0] as CaseMarket;
  const price = forecast(market.prices);
  writeFileSync(
    join(OUTPUT_DIR, `${id}.out`),
    `${JSON.stringify({ forecasts: [{ case: id, price }] })}\n`,
  );
}
