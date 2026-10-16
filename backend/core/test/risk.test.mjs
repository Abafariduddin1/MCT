import test from 'node:test';
import assert from 'node:assert/strict';
import { config, TOKEN_PROGRAM } from '../src/config.mjs';
import { screen, Signals, positionSize, entryBlock, exitReason, updateRisk } from '../src/risk.mjs';
const c = config({});
const now = Date.now();
const token = () => ({ id: 'token', tokenProgram: TOKEN_PROGRAM, decimals: 6, isVerified: true,
  firstPool: { createdAt: new Date(now - 72 * 3600000).toISOString() },
  liquidity: 200000, holderCount: 1000, organicScore: 80, usdPrice: 1, priceBlockId: 1000,
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15 },
  stats1h: { buyVolume: 50000, sellVolume: 30000 }, stats5m: { buyVolume: 6000, sellVolume: 4000 } });
const state = () => ({ equity: 200, cash: 200, highWater: 200, maxDrawdown: 0, day: new Date(now).toISOString().slice(0,10),
  dayStart: 200, dayEntries: 0, positions: [], cooldowns: {}, halt: null, paused: false, pending: null });
test('screen fails closed on missing audits and rejects young, concentrated, stale and extended-program tokens', () => {
  assert.equal(screen(token(), c, now, 1005), null);
  const missing = token(); delete missing.audit.topHoldersPercentage;
  assert.match(screen(missing, c, now, 1005), /concentration/);
  const concentrated = token(); concentrated.audit.topHoldersPercentage = 50;
  assert.match(screen(concentrated, c, now, 1005), /Concentrated/);
  const young = token(); young.firstPool.createdAt = new Date(now - 3600000).toISOString();
  assert.match(screen(young, c, now, 1005), /young/);
  assert.match(screen(token(), c, now, 1400), /Stale/);
  assert.match(screen({ ...token(), tokenProgram: 'other' }, c, now, 1005), /Token-2022/);
});
test('momentum needs time-separated advancing price blocks and rejects stale snapshots', () => {
  const signals = new Signals(c);
  assert.equal(signals.observe(token(), now).enter, false);
  assert.equal(signals.observe({ ...token(), usdPrice: 1.1 }, now + 60000).enter, false);
  assert.equal(signals.observe({ ...token(), usdPrice: 1.002, priceBlockId: 1100 }, now + 60000).enter, false);
  assert.equal(signals.observe({ ...token(), usdPrice: 1.005, priceBlockId: 1200 }, now + 120000).enter, false);
  assert.equal(signals.observe({ ...token(), usdPrice: 1.01, priceBlockId: 1300 }, now + 180000).enter, true);
  assert.equal(signals.observe({ ...token(), usdPrice: 1.08, priceBlockId: 1400 }, now + 240000).enter, false);
});
test('loss, exposure and pending orders block entries', () => {
  const s = state();
  assert.equal(positionSize(s, c), 7.69);
  s.positions = [{ mint: 'a', cost: 20 }]; assert.equal(positionSize(s, c), 0);
  s.positions = []; s.pending = { signature: 'x' }; assert.match(entryBlock(s, c, 'a'), /pending/);
  s.pending = null; s.equity = 194; updateRisk(s, c, now); assert.match(s.halt, /Daily/);
  assert.match(entryBlock(s, c, 'a'), /paused/);
});
test('stops and trailing exits use estimated sale proceeds after costs', () => {
  const p = { cost: 10, mark: 9.1, peak: 10, openedAt: now };
  assert.equal(exitReason(p, c, now), 'Stop loss');
  assert.equal(exitReason({ ...p, mark: 11.7, peak: 11.7 }, c, now), 'Take profit');
  assert.equal(exitReason({ ...p, mark: 10.4, peak: 11.2 }, c, now), 'Trailing stop');
});
test('invalid environment values cannot silently enable live mode or oversized positions', () => {
  assert.equal(config({}).mode, 'paper');
  for (const env of [{ MODE: 'true' }, { MAX_POSITION_USDC: 'NaN' }, { MAX_SLIPPAGE_BPS: '9000' }, { REQUIRE_VERIFIED: 'yes' }])
    assert.throws(() => config(env));
});
test('position sizing reserves entry fees and combined fee caps cannot be inconsistent',()=>{
  assert.ok(positionSize(state(),c,0.21)<positionSize(state(),c));
  assert.throws(()=>config({MAX_NETWORK_FEE_LAMPORTS:'5000'}),/fee/);
  assert.equal(config({PAPER_NETWORK_LAMPORTS:'55000'}).paperNetwork,56000);
});
