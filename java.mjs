// aztec-flush.mjs - Dynamic Sync + MEV Bundle Support
import { ethers } from 'ethers';
import axios from 'axios';
import 'dotenv/config';

const CHECK_INTERVAL_MS = 1000;
const MAX_REWARD_TO_CLAIM = 1000n * 10n ** 18n;
const GAS_LIMIT = 300000n;

// ── Konfigurasi Mode & Gas ─────────────────────────────────
const FLUSH_MODE = (process.env.FLUSH_MODE || 'pre').toLowerCase();
const PRE_SEND_SECONDS = parseFloat(process.env.PRE_SEND_SECONDS || '5');
const EPOCH_WINDOW_SEC = parseFloat(process.env.FLUSH_VALID || '7');
const GAS_GWEI = process.env.GAS_GWEI ? parseFloat(process.env.GAS_GWEI) : null;
const USE_MEV_BUNDLE = (process.env.USE_MEV_BUNDLE || 'false').toLowerCase() === 'true';

if (!['local', 'pre', 'block', 'local-pre'].includes(FLUSH_MODE)) {
  throw new Error('❌ Invalid FLUSH_MODE. Use: local, pre, block, or local-pre');
}

const FLUSH_ADDR = '0x7C9a7130379F1B5dd6e7A53AF84fC0fE32267B65';
const ROLLUP_ADDR = '0x603bb2c05D474794ea97805e8De69bCcFb3bCA12';

const READ_RPC_URL = process.env.READ_RPC_URL || process.env.RPC_URL;
const WRITE_RPC_URL = process.env.WRITE_RPC_URL || process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!READ_RPC_URL) throw new Error("❌ Missing READ_RPC_URL");
if (!WRITE_RPC_URL) throw new Error("❌ Missing WRITE_RPC_URL");
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE_KEY");

const readProvider = new ethers.JsonRpcProvider(READ_RPC_URL);
const writeProvider = new ethers.JsonRpcProvider(WRITE_RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, writeProvider);

const FLUSH_ABI = [
  "function flushEntryQueue()",
  "function rewardsOf(address) view returns (uint256)",
  "function claimRewards()",
  "function rewardsAvailable() view returns (uint256)"
];

const ROLLUP_ABI = [
  "function getCurrentSlot() view returns (uint256)",
  "function getSlotDuration() view returns (uint256)",
  "function getEpochDuration() view returns (uint256)",
  "function getActiveAttesterCount() view returns (uint256)",
  "function isRewardsClaimable() view returns (bool)"
];

const flushRead = new ethers.Contract(FLUSH_ADDR, FLUSH_ABI, readProvider);
const flushWrite = new ethers.Contract(FLUSH_ADDR, FLUSH_ABI, wallet);
const rollupRead = new ethers.Contract(ROLLUP_ADDR, ROLLUP_ABI, readProvider);

const BUILDERS = {
  flashbots: "https://relay.flashbots.net",
  titan: "https://rpc.titanbuilder.xyz",
  beaver: "https://rpc.beaverbuild.org",
  bobthebuilder: "https://rpc.bobthebuilder.xyz",
  bloxroute: "https://rpc-builder.blxrbdn.com",
  quasar: "https://rpc.quasar.win",
  eureka: "https://rpc.eurekabuilder.xyz"
};

const toBigInt = (val) => {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string') return BigInt(val);
  if (typeof val === 'number') return BigInt(Math.floor(val));
  if (val && val._hex) return BigInt(val._hex);
  return 0n;
};

let lastOnChainSeconds = -1;
let cachedOnChainState = null;

let localStartTimeMs = 0;
let localEpochStartSec = 0;
let localEpochDurationSec = 2304;
let localCurrentEpoch = 0n;

async function getOnChainState() {
  const [
    currentSlot,
    slotDurationSec,
    slotsPerEpoch,
    activeAttesters,
    isClaimable,
    userReward,
    poolReward
  ] = await Promise.all([
    rollupRead.getCurrentSlot(),
    rollupRead.getSlotDuration(),
    rollupRead.getEpochDuration(),
    rollupRead.getActiveAttesterCount(),
    rollupRead.isRewardsClaimable(),
    flushRead.rewardsOf(wallet.address),
    flushRead.rewardsAvailable()
  ]);

  const epochNum = slotsPerEpoch > 0n ? toBigInt(currentSlot) / toBigInt(slotsPerEpoch) : 0n;
  const slotsIntoEpoch = toBigInt(currentSlot) % toBigInt(slotsPerEpoch);
  const secondsIntoEpoch = slotsIntoEpoch * toBigInt(slotDurationSec);
  const epochDurationSec = Number(toBigInt(slotsPerEpoch) * toBigInt(slotDurationSec));

  return {
    currentSlot: toBigInt(currentSlot),
    slotDurationSec: toBigInt(slotDurationSec),
    slotsPerEpoch: toBigInt(slotsPerEpoch),
    epochNum,
    slotsIntoEpoch,
    secondsIntoEpoch,
    activeAttesters: toBigInt(activeAttesters),
    isClaimable,
    userReward: toBigInt(userReward),
    poolReward: toBigInt(poolReward),
    epochDurationSec
  };
}

function syncLocalToOnChain(onchainSeconds, onchainEpoch, epochDuration) {
  localStartTimeMs = Date.now();
  localEpochStartSec = onchainSeconds;
  localEpochDurationSec = epochDuration;
  localCurrentEpoch = onchainEpoch;
  console.log(`🔄 LOCAL synced to on-chain: ${onchainSeconds.toFixed(2)}s`);
}

function getLocalTime() {
  if (localStartTimeMs === 0) {
    return { seconds: 0, nextEpochIn: localEpochDurationSec, epoch: localCurrentEpoch };
  }
  
  const nowMs = Date.now();
  const elapsedSec = (nowMs - localStartTimeMs) / 1000;
  const secondsInCurrentEpoch = localEpochStartSec + elapsedSec;
  
  if (secondsInCurrentEpoch >= localEpochDurationSec) {
    const epochsPassed = Math.floor(secondsInCurrentEpoch / localEpochDurationSec);
    localCurrentEpoch += BigInt(epochsPassed);
    localEpochStartSec -= epochsPassed * localEpochDurationSec;
    localStartTimeMs = nowMs - ((secondsInCurrentEpoch % localEpochDurationSec) * 1000);
    return getLocalTime();
  }
  
  const nextEpochIn = localEpochDurationSec - secondsInCurrentEpoch;
  return {
    seconds: secondsInCurrentEpoch,
    nextEpochIn,
    epoch: localCurrentEpoch
  };
}

async function createRawTx(contract, method, args = [], maxFee, maxPrio, nonce) {
  const tx = await contract[method].populateTransaction(...args, {
    gasLimit: method === "flushEntryQueue" ? GAS_LIMIT : 700000n,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPrio,
    nonce,
    chainId: 1,
    type: 2
  });
  return await wallet.signTransaction(tx);
}

async function sendBundle(rawTxs, targetBlock) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [{
      txs: rawTxs,
      blockNumber: `0x${targetBlock.toString(16)}`
    }]
  };

  const headers = { "Content-Type": "application/json" };
  const results = await Promise.allSettled(
    Object.entries(BUILDERS).map(async ([name, url]) => {
      try {
        await axios.post(url.trim(), body, { headers, timeout: 5000 });
        return { name, success: true };
      } catch (e) {
        return { name, success: false };
      }
    })
  );

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  console.log(`✅ Bundle sent to ${successCount}/${Object.keys(BUILDERS).length} builders`);
}

async function tryFlush(epochNum) {
  try {
    const currentSlot = toBigInt(await rollupRead.getCurrentSlot());
    const slotsPerEpoch = toBigInt(await rollupRead.getEpochDuration());
    const slotDuration = toBigInt(await rollupRead.getSlotDuration());
    const secondsInto = Number((currentSlot % slotsPerEpoch) * slotDuration);

    if (secondsInto > EPOCH_WINDOW_SEC) {
      console.log(`⚠️ Skipped flush: already ${secondsInto.toFixed(2)}s into epoch`);
      return false;
    }

    const timeString = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`🔍 Flushing epoch ${epochNum} at ${timeString}`);

    const before = await flushRead.rewardsOf(wallet.address);
    const beforeBigInt = toBigInt(before);

    let maxFee, maxPrio;
    if (GAS_GWEI !== null) {
      const gweiInWei = ethers.parseUnits(GAS_GWEI.toString(), 'gwei');
      maxFee = gweiInWei;
      maxPrio = gweiInWei;
    } else {
      const feeData = await writeProvider.getFeeData();
      maxFee = feeData.maxFeePerGas ? toBigInt(feeData.maxFeePerGas) : 2_000_000_000n;
      maxPrio = feeData.maxPriorityFeePerGas ? toBigInt(feeData.maxPriorityFeePerGas) : 1_000_000_000n;
      maxFee = (maxFee * 130n) / 100n;
      maxPrio = (maxPrio * 130n) / 100n;
    }

    if (USE_MEV_BUNDLE) {
      const nonce = await writeProvider.getTransactionCount(wallet.address, "pending");
      const rawTx = await createRawTx(flushWrite, "flushEntryQueue", [], maxFee, maxPrio, nonce);
      const targetBlock = (await writeProvider.getBlockNumber()) + 2;
      console.log(`📦 MEV Bundle | Target block: ${targetBlock}`);
      await sendBundle([rawTx], targetBlock);
      console.log(`🎉 MEV flush bundle submitted for epoch ${epochNum}`);
      return true;
    } else {
      const tx = await flushWrite.flushEntryQueue({
        gasLimit: GAS_LIMIT,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: maxPrio
      });
      console.log(`📤 Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      const gasUsed = BigInt(receipt.gasUsed);
      const gasPrice = BigInt(receipt.effectiveGasPrice || receipt.gasPrice || 0n);
      const gasCost = ethers.formatEther(gasUsed * gasPrice);
      const after = await flushRead.rewardsOf(wallet.address);
      const earned = toBigInt(after) - beforeBigInt;
      if (earned > 0n) {
        const aztec = ethers.formatUnits(earned, 18);
        console.log(`🎉 SUCCESS! +${aztec} $AZTEC | Confirmed in block: ${receipt.blockNumber} | Gas: ${gasCost} ETH`);
      } else {
        console.log(`ℹ️ Flush succeeded in block ${receipt.blockNumber}, but no reward. Gas: ${gasCost} ETH`);
      }
      return earned > 0n;
    }
  } catch (e) {
    if (e.message.includes('no validators') || e.message.includes('already flushed')) {
      console.log('ℹ️ No validators in queue.');
    } else {
      console.error('💥 Flush failed:', e.message);
    }
    return false;
  }
}

async function autoClaim() {
  try {
    const claimable = await rollupRead.isRewardsClaimable().catch(() => true);
    if (!claimable) return;

    const r = toBigInt(await flushRead.rewardsOf(wallet.address));
    if (r > 0n && r <= MAX_REWARD_TO_CLAIM) {
      console.log(`🪙 Claiming: ${ethers.formatUnits(r, 18)} $AZTEC`);

      let maxFee, maxPrio;
      if (GAS_GWEI !== null) {
        const gweiInWei = ethers.parseUnits(GAS_GWEI.toString(), 'gwei');
        maxFee = gweiInWei;
        maxPrio = gweiInWei;
      } else {
        const feeData = await writeProvider.getFeeData();
        maxFee = feeData.maxFeePerGas ? toBigInt(feeData.maxFeePerGas) : 2_000_000_000n;
        maxPrio = feeData.maxPriorityFeePerGas ? toBigInt(feeData.maxPriorityFeePerGas) : 1_000_000_000n;
        maxFee = (maxFee * 130n) / 100n;
        maxPrio = (maxPrio * 130n) / 100n;
      }

      if (USE_MEV_BUNDLE) {
        const nonce = await writeProvider.getTransactionCount(wallet.address, "pending");
        const rawTx = await createRawTx(flushWrite, "claimRewards", [], maxFee, maxPrio, nonce);
        const targetBlock = (await writeProvider.getBlockNumber()) + 2;
        console.log(`📦 MEV Claim Bundle | Target block: ${targetBlock}`);
        await sendBundle([rawTx], targetBlock);
        console.log(`✅ MEV claim bundle submitted`);
      } else {
        const tx = await flushWrite.claimRewards();
        await tx.wait();
        console.log('✅ Claim success!');
      }
    }
  } catch (e) {
    console.error('⚠️ Claim failed:', e.message);
  }
}

function formatTimeRemaining(seconds) {
  if (seconds <= 0) return "Now!";
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}m ${secs}s`;
}

async function run() {
  const balance = await readProvider.getBalance(wallet.address);
  console.log(`🚀 Bot active | Wallet: ${wallet.address}`);
  console.log(`💰 ETH Balance: ${ethers.formatEther(balance)} ETH`);
  console.log(`📡 Read RPC: ${READ_RPC_URL.replace(/(.*)(.{4})$/, '***$2')}`);
  console.log(`📤 Write RPC: ${WRITE_RPC_URL.replace(/(.*)(.{4})$/, '***$2')}`);
  
  let modeDesc = FLUSH_MODE;
  if (['pre', 'local-pre'].includes(FLUSH_MODE)) {
    modeDesc += ` (send ${PRE_SEND_SECONDS}s before next epoch)`;
  }
  console.log(`⏱️  Flush mode: ${modeDesc}`);
  console.log(`⏱️  Flush window: first ${EPOCH_WINDOW_SEC}s of epoch`);
  if (GAS_GWEI !== null) {
    console.log(`⛽ Manual gas: ${GAS_GWEI} Gwei`);
  }
  console.log(`🛡️  MEV Bundle: ${USE_MEV_BUNDLE ? 'ENABLED' : 'DISABLED'}`);
  console.log('');

  console.log("🔄 Initializing...");
  const initialState = await getOnChainState();
  lastOnChainSeconds = Number(initialState.secondsIntoEpoch);
  cachedOnChainState = initialState;
  syncLocalToOnChain(
    lastOnChainSeconds,
    initialState.epochNum,
    initialState.epochDurationSec || 2304
  );

  let lastFlushedEpoch = -1n;

  while (true) {
    try {
      let newState;
      try {
        newState = await getOnChainState();
        cachedOnChainState = newState;
      } catch (e) {
        console.warn("⚠️ Failed to read on-chain state, using cached values...");
        newState = cachedOnChainState;
      }

      if (!newState) {
        await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
        continue;
      }

      const currentOnChainSeconds = Number(newState.secondsIntoEpoch);
      const currentOnChainEpoch = newState.epochNum;
      const currentEpochDuration = newState.epochDurationSec || 2304;

      if (currentOnChainSeconds !== lastOnChainSeconds) {
        lastOnChainSeconds = currentOnChainSeconds;
        syncLocalToOnChain(currentOnChainSeconds, currentOnChainEpoch, currentEpochDuration);
      }

      const onchainSeconds = currentOnChainSeconds;
      const onchainEpoch = currentOnChainEpoch;
      const onchainNextEpochIn = currentEpochDuration - onchainSeconds;
      const { seconds: localSeconds, nextEpochIn: localNextEpochIn, epoch: localEpoch } = getLocalTime();

      const rewardsAZTEC = ethers.formatUnits(newState.userReward, 18);
      const poolAZTEC = ethers.formatUnits(newState.poolReward, 18);
      const attesters = newState.activeAttesters.toString();

      const onchainFormatted = `${onchainSeconds.toFixed(2)}s`;
      const localFormatted = `${localSeconds.toFixed(2)}s`;
      const onchainCountdown = formatTimeRemaining(onchainNextEpochIn);
      const localCountdown = formatTimeRemaining(localNextEpochIn);

      console.log(
        `[${new Date().toLocaleTimeString()}] 📊 Epoch (on-chain: ${onchainEpoch.toString()}, local: ${localEpoch.toString()})\n` +
        `   💰 Your rewards : ${rewardsAZTEC} $AZTEC\n` +
        `   🏦 Reward Pool  : ${poolAZTEC} $AZTEC\n` +
        `   👥 Attesters    : ${attesters}\n` +
        `   ⏱️ On-chain     : ${onchainFormatted}\n` +
        `   🕒 LOCAL        : ${localFormatted}\n` +
        `   ⏳ Next epoch in: on-chain=${onchainCountdown} | local=${localCountdown}\n`
      );

      if (newState.userReward > 0n) await autoClaim();

      let shouldFlush = false;
      let flushReason = "";
      let targetEpoch = onchainEpoch;

      if (FLUSH_MODE === 'block') {
        if (onchainSeconds <= EPOCH_WINDOW_SEC && onchainEpoch !== lastFlushedEpoch) {
          shouldFlush = true;
          flushReason = "on-chain time in flush window";
        }
      } else if (FLUSH_MODE === 'local') {
        if (localSeconds <= EPOCH_WINDOW_SEC && localEpoch !== lastFlushedEpoch) {
          shouldFlush = true;
          flushReason = "LOCAL time in window";
          targetEpoch = localEpoch;
        }
      } else if (FLUSH_MODE === 'pre') {
        if (onchainNextEpochIn <= PRE_SEND_SECONDS && onchainEpoch !== lastFlushedEpoch) {
          shouldFlush = true;
          flushReason = `pre-send (on-chain, ${onchainNextEpochIn.toFixed(2)}s before next epoch)`;
          targetEpoch = onchainEpoch + 1n;
        }
      } else if (FLUSH_MODE === 'local-pre') {
        if (localNextEpochIn <= PRE_SEND_SECONDS && localEpoch !== lastFlushedEpoch) {
          shouldFlush = true;
          flushReason = `LOCAL-PRE: ${localNextEpochIn.toFixed(2)}s before next epoch`;
          targetEpoch = localEpoch + 1n;
        }
      }

      if (shouldFlush) {
        console.log(`🎯 Flush triggered: ${flushReason}`);
        await tryFlush(targetEpoch);
        await autoClaim();
        lastFlushedEpoch = targetEpoch;
      }

    } catch (e) {
      console.error('❌ Loop error:', e.message);
    }
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

run().catch(console.error);

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  process.exit(0);
});
