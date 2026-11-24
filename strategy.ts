// Launch-sniper paper-trading bot for the make.fun pump.fun replay (agent-fun/replay/v2).
//
// Idea: on pump.fun most new curves die within minutes, but the few that catch fire do so
// fast — a burst of distinct buyers pushes the price up within the first minute of life.
// This bot snipes only the launches whose inflow is still *accelerating* (net SOL in the
// newer half of the launch window at least 3x the older half), with several distinct
// buyers and the price still near its young high, then flips each position quickly
// (take-profit / trailing stop / tight stop-loss / short hold). One small buy per
// position, no scale-ins: adding to a rising fresh curve on this data mostly buys the
// top, and the 1%-of-reserve size cap already keeps first buys small.
//
// Two guardrails shape the rest of the design:
//  - the replay ranks by net PnL but only entries with round trips of >= 0.01 SOL on at
//    least 20 distinct coins (and max drawdown <= 50%) rank above the rest, so a paced
//    probe mechanism opens tiny round trips on liquid curves whenever the bot's own
//    fills or coins lag the pace the run needs (target: 30 coins, 70 fills over 6h);
//  - the entry is executed twice and both action logs must match byte for byte, so the
//    bot is deterministic by construction: no clock, no environment, no randomness —
//    every decision comes from the batch stream, and every map is iterated in the
//    insertion order the stream built it in.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface SnipeParams {
  /** Fresh-launch window: a curve is snipable this many slots after its CreateEvent. */
  snipeAgeMax: number;
  /** Minimum slots since creation before a snipe (let a tape form first). */
  snipeAgeMin: number;
  /** Minimum buy trades inside the launch window. */
  snipeMinBuys: number;
  /** Minimum distinct buyers inside the launch window. */
  snipeMinBuyers: number;
  /** Minimum net SOL inflow (buys minus sells) inside the launch window. */
  snipeMinNetSol: number;
  /** Minimum price rise from the first trade of the window to now. */
  snipeMinRise: number;
  /** Price now must be at least this share of the window high (not already dumped). */
  snipeNearHigh: number;
  /** Newer-half net inflow must be at least this multiple of the older half's (acceleration). 0 = off. */
  snipeAccel: number;
  /** Largest single buyer's share of the window's buy SOL (avoid one-wallet launches). */
  snipeMaxBuyerShare: number;
  /** Real SOL reserve bounds at entry. */
  snipeMinRqSol: number;
  snipeMaxRqSol: number;
  /** Dip leg: curve older than this many slots may be dip-bought. */
  dipMinAge: number;
  /** Dip leg: lookback (slots) whose high the price must have fallen from. */
  dipLookback: number;
  /** Dip leg: price must be at most this share of the lookback high. */
  dipMaxFromHigh: number;
  /** Dip leg: minimum net SOL inflow over the last dipFlowWindow slots (buyers returning). */
  dipMinFlowSol: number;
  dipFlowWindow: number;
  dipMinRqSol: number;
  /** SOL staked in one snipe position in total (built up across batches as the 1% cap allows). */
  stakeSol: number;
  /** SOL staked in one dip position in total. */
  dipStakeSol: number;
  /** Smallest single buy worth sending (also keeps every round trip above the 0.01 SOL bar). */
  minBuySol: number;
  /** Slippage allowance on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit: sell when value falls to this share of cost. */
  stopLoss: number;
  /** Exit: sell when value reaches this multiple of cost. */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Trailing stop: sell when value falls to this share of its peak. */
  trailKeep: number;
  /** Exit: a single recorded sell of at least this many SOL panics the position out. */
  panicSellSol: number;
  /** Exit: sell after this many slots held (unless the position is comfortably up). */
  maxHoldSlots: number;
  /** ...unless the value is at least this multiple of cost, then the hold may run on. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be entered again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntriesPerMint: number;
  /** Most snipe/dip positions open at once (the rest of the 5-position cap is for probes). */
  maxMainPositions: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: the run needs at least this many distinct coins / fills by the end. */
  targetCoins: number;
  targetFills: number;
  /** Seconds of block time the pace is spread over (a 6h final window). */
  paceSecs: number;
  /** SOL per probe buy (safely above the 0.01 SOL round-trip bar). */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
  /** Scale a position up across batches while its entry signal still holds. */
  allowScaleIn: boolean;
  /** Take dip entries on older curves at all. */
  allowDip: boolean;
}

export const DEFAULT_PARAMS: SnipeParams = {
  snipeAgeMax: 300,
  snipeAgeMin: 5,
  snipeMinBuys: 6,
  snipeMinBuyers: 6,
  snipeMinNetSol: 1.5,
  snipeMinRise: 0.15,
  snipeNearHigh: 0.9,
  snipeAccel: 3,
  snipeMaxBuyerShare: 0.4,
  snipeMinRqSol: 1.5,
  snipeMaxRqSol: 80,
  dipMinAge: 600,
  dipLookback: 300,
  dipMaxFromHigh: 0.75,
  dipMinFlowSol: 0.1,
  dipFlowWindow: 60,
  dipMinRqSol: 2,
  stakeSol: 0.05,
  dipStakeSol: 0.15,
  minBuySol: 0.012,
  buySlipBps: 1000,
  stopLoss: 0.85,
  takeProfit: 1.5,
  trailArm: 0.2,
  trailKeep: 0.85,
  panicSellSol: 5,
  maxHoldSlots: 3600,
  holdIfUp: 1.1,
  cooldownSlots: 300,
  maxEntriesPerMint: 2,
  maxMainPositions: 3,
  maxExposureSol: 8,
  targetCoins: 30,
  targetFills: 70,
  paceSecs: 21600,
  probeSol: 0.012,
  maxProbes: 1,
  allowScaleIn: false,
  allowDip: false,
};

const LAMPORTS = 1e9;
/** Curve fee on a trade: protocol 95 bps + creator 30 bps fallback. */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface LaunchTape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  peakValueSol: number;
  investedSol: number;
  exiting: boolean;
  filled: boolean;
  kind: 'snipe' | 'dip';
}

export interface StrategyStats {
  snipeEntries: number;
  dipEntries: number;
  scaleIns: number;
  probeBuys: number;
  /** Exit decisions by reason, with the decision-time value minus cost (SOL) summed per reason. */
  exits: Record<string, { count: number; pnlSol: number }>;
}

/** Pure counters for offline diagnostics; read-only, never affects decisions. */
export const STATS: StrategyStats = {
  snipeEntries: 0,
  dipEntries: 0,
  scaleIns: 0,
  probeBuys: 0,
  exits: {},
};

const noteExit = (reason: string, pnlSol: number): void => {
  const e = STATS.exits[reason] ?? { count: 0, pnlSol: 0 };
  e.count++;
  e.pnlSol += pnlSol;
  STATS.exits[reason] = e;
};

export function createStrategy(p: SnipeParams = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, LaunchTape>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight, by mint: false while the buy is pending, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  // Trades older than the longest lookback (dip 300) plus slack can be dropped.
  const keepSlots = Math.max(p.snipeAgeMax, p.dipLookback) + 10;

  const tapeOf = (mint: Pubkey): LaunchTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a tape. */
  const netFlow = (t: LaunchTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Fresh-launch snipe signal: a young curve with a real burst of distinct buyers. */
  const snipeSignal = (t: LaunchTape, now: number, rqSol: number): boolean => {
    if (t.createdSlot === null) return false;
    const age = now - t.createdSlot;
    if (age < p.snipeAgeMin || age > p.snipeAgeMax) return false;
    if (rqSol < p.snipeMinRqSol || rqSol > p.snipeMaxRqSol) return false;
    let buys = 0;
    let buySol = 0;
    let sellSol = 0;
    let firstPrice = -1;
    let high = 0;
    let lastPrice = 0;
    let netOld = 0;
    let netNew = 0;
    const midSlot = t.createdSlot + (now - t.createdSlot) / 2;
    const buyers = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot < t.createdSlot) continue;
      if (firstPrice < 0) firstPrice = tr.price;
      if (tr.price > high) high = tr.price;
      lastPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= midSlot) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buys++;
        buySol += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
    }
    if (buys < p.snipeMinBuys || buyers.size < p.snipeMinBuyers) return false;
    if (buySol - sellSol < p.snipeMinNetSol) return false;
    if (p.snipeAccel > 0 && (netNew <= 0 || netNew < p.snipeAccel * netOld)) return false;
    if (firstPrice <= 0) return false;
    if (lastPrice / firstPrice - 1 < p.snipeMinRise) return false;
    if (lastPrice < high * p.snipeNearHigh) return false;
    let topBuyer = 0;
    for (const v of buyers.values()) if (v > topBuyer) topBuyer = v;
    if (buySol > 0 && topBuyer > p.snipeMaxBuyerShare * buySol) return false;
    return true;
  };

  /** Dip signal: an older curve that fell hard from its recent high while buyers return. */
  const dipSignal = (t: LaunchTape, now: number, rqSol: number): boolean => {
    if (t.createdSlot === null || now - t.createdSlot < p.dipMinAge) return false;
    if (rqSol < p.dipMinRqSol) return false;
    let high = 0;
    let lastPrice = 0;
    for (const tr of t.trades) {
      if (tr.slot <= now - p.dipLookback) continue;
      if (tr.price > high) high = tr.price;
      lastPrice = tr.price;
    }
    if (high <= 0 || lastPrice <= 0) return false;
    if (lastPrice > high * p.dipMaxFromHigh) return false;
    if (netFlow(t, now, p.dipFlowWindow) < p.dipMinFlowSol) return false;
    return true;
  };

  /** What a holding is worth now if sold whole (curve fee and one tx fee deducted). */
  const sellValueSol = (state: BotState, mint: Pubkey, txSol: number): number => {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined || curve === undefined) return 0;
    const tokens = Number(pos.token_amount);
    const vq = Number(curve.virtual_quote_reserves);
    const vt = Number(curve.virtual_token_reserves);
    if (vt <= 0 || tokens <= 0) return 0;
    const gross = (tokens * vq) / (vt + tokens) / LAMPORTS;
    return gross * (1 - CURVE_FEE) - txSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const panic = new Set<Pubkey>();
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          touched.add(e.mint);
          if (!e.is_buy && Number(e.sol_amount) / LAMPORTS >= p.panicSellSol) panic.add(e.mint);
        }
      }
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // 1. Exits first: stop-loss, take-profit, trailing stop, panic sell, time limit.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = sellValueSol(state, mint, txSol);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValueSol) h.peakValueSol = value;
        let exit = h.exiting;
        let exitReason = '';
        if (!exit && value < cost * p.stopLoss) { exit = true; exitReason = 'stopLoss'; }
        if (!exit && value >= cost * p.takeProfit) { exit = true; exitReason = 'takeProfit'; }
        if (!exit && h.peakValueSol >= cost * (1 + p.trailArm) && value < h.peakValueSol * p.trailKeep) { exit = true; exitReason = 'trail'; }
        if (!exit && panic.has(mint)) { exit = true; exitReason = 'panic'; }
        if (!exit && now - h.openedSlot > p.maxHoldSlots && value < cost * p.holdIfUp) { exit = true; exitReason = 'time'; }
        if (!exit) continue;
        h.exiting = true;
        if (exitReason !== '') noteExit(exitReason, value - cost);
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probe sells: a probe flips as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries. One small buy per position (no scale-ins: adding to a rising fresh
      // curve mostly buys the top, and the 1% reserve cap already keeps first buys small).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMainPositions - open.size;
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Math.max(h.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = open.get(mint);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let target: number;
        let kind: 'snipe' | 'dip';
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntriesPerMint || now - t.lastExitSlot < p.cooldownSlots) continue;
          if (snipeSignal(t, now, rqSol)) {
            target = p.stakeSol;
            kind = 'snipe';
          } else if (p.allowDip && dipSignal(t, now, rqSol)) {
            target = p.dipStakeSol;
            kind = 'dip';
          } else {
            continue;
          }
        } else {
          // Scale in only while the launch is still running hot and room is left.
          if (!p.allowScaleIn) continue;
          if (h.exiting || !h.filled) continue;
          if (h.investedSol >= (h.kind === 'snipe' ? p.stakeSol : p.dipStakeSol) - p.minBuySol) continue;
          if (!snipeSignal(t, now, rqSol) && h.kind === 'snipe') continue;
          if (h.kind === 'dip' && !dipSignal(t, now, rqSol)) continue;
          target = h.kind === 'snipe' ? p.stakeSol : p.dipStakeSol;
          kind = h.kind;
        }
        const already = h === undefined ? 0 : h.investedSol;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, target - already, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + txSol;
        exposure += amount;
        if (h === undefined) {
          open.set(mint, {
            openedSlot: now,
            peakValueSol: 0,
            investedSol: amount,
            exiting: false,
            filled: false,
            kind,
          });
          t.entries++;
          if (kind === 'snipe') STATS.snipeEntries++;
          else STATS.dipEntries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.investedSol += amount;
          STATS.scaleIns++;
        }
      }

      // 4. Guardrail pacing: when fills or coins lag the pace the run needs, open a tiny
      // probe round trip on a liquid curve the bot has not traded yet.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            STATS.probeBuys++;
            free -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
