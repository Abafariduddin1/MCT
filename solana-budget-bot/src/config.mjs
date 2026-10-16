import path from 'node:path';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export function config(env = process.env) {
  const number = (name, fallback, min, max, integer = false) => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new Error(`Invalid ${name}: expected ${integer ? 'integer' : 'number'} from ${min} to ${max}`);
    return value;
  };
  const mode = env.MODE ?? 'paper';
  if (!['paper', 'live'].includes(mode)) throw new Error('MODE must be paper or live');
  const strategy = env.STRATEGY || 'hybrid';
  if (!['momentum', 'copy', 'hybrid'].includes(strategy)) throw new Error('STRATEGY must be momentum, copy or hybrid');
  const normalPct = number('NORMAL_ALLOCATION_PCT', strategy === 'copy' ? 0 : strategy === 'momentum' ? 80 : 50, 0, 100);
  const copyPct = number('COPY_ALLOCATION_PCT', strategy === 'momentum' ? 0 : strategy === 'copy' ? 80 : 30, 0, 100);
  if (normalPct + copyPct > 100) throw new Error('Normal + copy allocations cannot exceed 100%');
  const liveReady = env.ENABLE_LIVE_TRADING === 'true';
  if (env.ENABLE_LIVE_TRADING !== undefined && !['true','false'].includes(env.ENABLE_LIVE_TRADING)) throw new Error('ENABLE_LIVE_TRADING must be true or false');
  const normalStrategies = (env.NORMAL_STRATEGIES || 'momentum,breakout,pullback').split(',').map(x=>x.trim()).filter(Boolean);
  if (!normalStrategies.length || normalStrategies.some(x=>!['momentum','breakout','pullback','mean_reversion'].includes(x))) throw new Error('Unknown NORMAL_STRATEGIES');
  if (normalStrategies.includes('mean_reversion') && env.ENABLE_EXPERIMENTAL_MEAN_REVERSION !== 'true') throw new Error('Mean reversion requires ENABLE_EXPERIMENTAL_MEAN_REVERSION=true');
  const paperBase=env.PAPER_BASE||'USDC';
  if(!['SOL','USDC'].includes(paperBase))throw new Error('PAPER_BASE must be SOL or USDC');
  const liveCommitment=env.LIVE_SETTLEMENT_COMMITMENT||'finalized';
  if(!['confirmed','finalized'].includes(liveCommitment))throw new Error('LIVE_SETTLEMENT_COMMITMENT must be confirmed or finalized');
  const copyCommitment=env.COPY_COMMITMENT||'finalized';
  if(copyCommitment!=='finalized')throw new Error('COPY_COMMITMENT must be finalized for the filtered Helius history source');
  const wsEnabled=env.COPY_STREAM_ENABLED!=='false';
  if(env.COPY_STREAM_ENABLED!==undefined&&!['true','false'].includes(env.COPY_STREAM_ENABLED))throw new Error('COPY_STREAM_ENABLED must be true or false');
  let wsUrl=env.RPC_WS_URL||'';
  if(!wsUrl&&env.RPC_HTTP_URL){try{const u=new URL(env.RPC_HTTP_URL);u.protocol='wss:';wsUrl=u.href;}catch{}}
  if(wsUrl){try{if(new URL(wsUrl).protocol!=='wss:')throw Error();}catch{throw new Error('RPC_WS_URL must be a valid WSS URL');}}
  const c = {
    mode, strategy, liveReady, normalStrategies, normalPct, copyPct, reservePct:100-normalPct-copyPct,
    paperBase,liveCommitment,copyCommitment,wsEnabled,wsUrl,
    apiKey: env.JUPITER_API_KEY ?? '', rpc: env.RPC_HTTP_URL ?? '',
    dataDir: path.resolve(env.DATA_DIR || './data-v4', mode),
    walletFile: path.resolve(env.WALLET_FILE || './wallet.json'), liveAck: env.LIVE_ACK || '',
    telegramToken: env.TELEGRAM_BOT_TOKEN || '', telegramChat: env.TELEGRAM_CHAT_ID || '',
    paperBalance: number('PAPER_BALANCE_USDC', 200, 1, 10000),
    paperBalanceEur:number('PAPER_BALANCE_EUR',200,1,10000),
    paperInitialSol:number('PAPER_INITIAL_SOL',0,0,1000),
    eurUsd:number('EUR_USD_REFERENCE',0,0,10),
    maxPosition: number('MAX_POSITION_USDC', 10, 1, 200),
    risk: number('RISK_PER_TRADE_USDC', 1, 0.01, 20),
    maxOpen: number('MAX_OPEN_POSITIONS', 2, 1, 4, true),
    maxOpenPerBucket: number('MAX_OPEN_PER_BUCKET', 1, 1, 2, true),
    maxExposure: number('MAX_EXPOSURE_USDC', 20, 1, 200),
    maxEntries: number('MAX_ENTRIES_PER_DAY', 4, 1, 20, true),
    dailyLoss: number('DAILY_LOSS_LIMIT_USDC', 5, 0.01, 200),
    totalLoss: number('TOTAL_DRAWDOWN_LIMIT_USDC', 15, 0.01, 200),
    stop: number('STOP_LOSS_PCT', 8, 1, 50), take: number('TAKE_PROFIT_PCT', 16, 1, 200),
    trailStart: number('TRAIL_START_PCT', 10, 1, 200), trail: number('TRAIL_DISTANCE_PCT', 6, 1, 50),
    holdMs: number('MAX_HOLD_MINUTES', 60, 1, 1440) * 60000,
    cooldownMs: number('COOLDOWN_MINUTES', 120, 1, 1440) * 60000,
    roundTrip: number('MAX_ROUND_TRIP_COST_PCT', 5, 0.1, 10),
    slippage: number('MAX_SLIPPAGE_BPS', 50, 1, 200, true),
    exitSlippage: number('EXIT_SLIPPAGE_BPS', 100, 1, 200, true),
    impact: number('MAX_ENTRY_PRICE_IMPACT_PCT', 1, 0.01, 5),
    swapFee: number('MAX_SWAP_FEE_BPS', 20, 0, 100, true),
    exitSwapFee: number('MAX_EXIT_SWAP_FEE_BPS', 100, 0, 200, true),
    priority: number('MAX_PRIORITY_FEE_LAMPORTS', 50000, 0, 1000000, true),
    jitoTip: number('JITO_TIP_LAMPORTS', 1000, 1000, 100000, true),
    networkCap: number('MAX_NETWORK_FEE_LAMPORTS', 100000, 5000, 2000000, true),
    rentCap: number('MAX_RENT_LAMPORTS', 2500000, 0, 10000000, true),
    paperSlip: number('PAPER_ADVERSE_FILL_BPS', 30, 0, 200, true),
    paperNetwork: number('PAPER_NETWORK_LAMPORTS', 56000, 5000, 2000000, true),
    paperRent: number('PAPER_ENTRY_RENT_LAMPORTS', 2039280, 0, 10000000, true),
    ageHours: number('MIN_AGE_HOURS', 48, 24, 100000),
    liquidity: number('MIN_LIQUIDITY_USD', 100000, 10000, 1e12),
    volume: number('MIN_VOLUME_1H_USD', 50000, 0, 1e12),
    holders: number('MIN_HOLDERS', 500, 100, 1e9, true),
    topHolders: number('MAX_TOP_HOLDERS_PCT', 25, 1, 50),
    organic: number('MIN_ORGANIC_SCORE', 60, 0, 100),
    verified: env.REQUIRE_VERIFIED === undefined ? true : env.REQUIRE_VERIFIED === 'true',
    priceAgeSlots: number('MAX_PRICE_AGE_SLOTS', 300, 50, 2000, true),
    buySell: number('MIN_BUY_SELL_RATIO', 1.15, 1, 5),
    minRewardCost: number('MIN_REWARD_TO_COST_RATIO', 2, 1, 10),
    trendWindowMs: number('TREND_WINDOW_MINUTES', 10, 5, 60) * 60000,
    breakoutPct: number('BREAKOUT_BUFFER_PCT', 0.2, 0.05, 2),
    maxJump: number('MAX_ONE_TICK_JUMP_PCT', 5, 1, 20),
    windowMs: number('SIGNAL_WINDOW_MINUTES', 3, 2, 60) * 60000,
    signalSampleMs:number('SIGNAL_SAMPLE_SECONDS',5,1,60)*1000,
    minMomentum: number('MIN_MOMENTUM_PCT', 0.5, 0.01, 10),
    maxMomentum: number('MAX_MOMENTUM_PCT', 4, 0.01, 20),
    scanMs: number('SCAN_SECONDS', 60, 30, 3600) * 1000,
    monitorMs: number('MONITOR_SECONDS', 1, 0.5, 120) * 1000,
    shortlistMs:number('SHORTLIST_SECONDS',1,0.5,120)*1000,
    shortlistSize:number('SHORTLIST_SIZE',30,1,100,true),
    candidates: number('MAX_CANDIDATES', 200, 1, 500, true),
    apiMs: number('API_MIN_INTERVAL_MS', 1050, 1000, 10000, true),
    metadataTtlMs:number('METADATA_CACHE_MS',1500,0,10000,true),
    referenceMs:number('REFERENCE_SECONDS',1,1,120)*1000,
    exitQuoteMs:number('EXIT_ROUTE_REFRESH_SECONDS',10,1,120)*1000,
    loopMs:number('SCHEDULER_MAX_WAIT_MS',100,10,1000,true),
    latencyTargetMs:number('LATENCY_TARGET_MS',1000,100,10000,true),
    liveCap: number('LIVE_INITIAL_USDC_CAP', 30, 1, 200),
    reserveSol: number('MIN_SOL_RESERVE', 0.005, 0.002, 1),
    copyLeader: (env.COPY_LEADER || '').trim(),
    copyPollMs: number('COPY_POLL_SECONDS', 60, 5, 300) * 1000,
    copyFetchCooldownMs:number('COPY_EVENT_FETCH_MS',750,250,5000,true),
    copyMaxAgeMs: number('COPY_MAX_AGE_SECONDS', 60, 2, 300) * 1000,
    copyWorse: number('COPY_MAX_WORSE_PRICE_PCT', 1, 0, 5),
    copyBatch: number('COPY_MAX_TRANSACTIONS_PER_POLL', 10, 1, 20, true),
    copyPage: number('COPY_HISTORY_PAGE_SIZE', 100, 10, 100, true),
    copyPages: number('COPY_MAX_PAGES_PER_POLL', 3, 1, 10, true),
    copyCreditBudget: number('COPY_CREDIT_BUDGET_PER_DAY', 20000, 100, 100000, true),
    copyOverlap:number('COPY_HISTORY_OVERLAP_SLOTS',64,8,256,true),
    copyIndexWaitMs:number('COPY_INDEX_RETRY_MS',4000,1000,15000,true),
    streamCreditBudget:number('STREAM_CREDIT_BUDGET_PER_DAY',2000,10,100000,true),
    streamMaxBytes:number('STREAM_MAX_BYTES_PER_DAY',50000000,10000,1000000000,true),
    copyHoldMs: number('COPY_MAX_HOLD_MINUTES', 240, 1, 10080) * 60000,
    copyExitPolicy: env.COPY_EXIT_POLICY || 'proportional',
    watchlist: (env.WATCHLIST || '').split(',').map(x => x.trim()).filter(Boolean)
  };
  if (c.minMomentum > c.maxMomentum || c.paperSlip > c.slippage || c.scanMs > c.windowMs)
    throw new Error('Inconsistent momentum, scan interval or paper slippage settings');
  if (c.maxPosition > c.maxExposure) throw new Error('MAX_POSITION_USDC exceeds MAX_EXPOSURE_USDC');
  if (c.watchlist.length > 500) throw new Error('WATCHLIST is limited to 500 mints');
  if (c.strategy === 'copy' && !c.copyLeader) throw new Error('Set COPY_LEADER to the public wallet address to follow');
  if (!['proportional','full'].includes(c.copyExitPolicy)) throw new Error('COPY_EXIT_POLICY must be proportional or full');
  if (c.priority + c.jitoTip + 5000 > c.networkCap) throw new Error('Priority fee + Jito tip + signature fee exceed the network cap');
  // Old .env files used 55000; include the newly required tip without changing user keys.
  c.paperNetwork = Math.max(c.paperNetwork, c.priority + c.jitoTip + 5000);
  if (env.REQUIRE_VERIFIED !== undefined && !['true', 'false'].includes(env.REQUIRE_VERIFIED))
    throw new Error('REQUIRE_VERIFIED must be true or false');
  return c;
}
export function requireConnections(c) {
  if (!c.apiKey || /YOUR|PLACEHOLDER/.test(c.apiKey)) throw new Error('Set JUPITER_API_KEY in .env');
  let url;
  try { url = new URL(c.rpc); } catch { throw new Error('Set RPC_HTTP_URL in .env'); }
  if (url.protocol !== 'https:' || /YOUR|PLACEHOLDER/.test(c.rpc)) throw new Error('Set a valid HTTPS RPC_HTTP_URL');
}
