// run.mjs - Aztec Flush Bot (Simple & Accurate)
import { ethers } from 'ethers';
import 'dotenv/config';

const GENESIS_TIMESTAMP = 1733356800; // Dec 5, 2024 @ 00:00 UTC
const EPOCH_DURATION_SEC = 2304;       // ~38.4 minutes
const EPOCH_WINDOW_SEC = 15;           // Only first 15 seconds are valid
const CHECK_INTERVAL_MS = 10_000;      // Normal check every 10s
const MAX_REWARD_TO_CLAIM = ethers.parseEther("1000");

if (!process.env.RPC_URL) throw new Error("❌ Missing RPC_URL in .env");
if (!process.env.PRIVATE_KEY) throw new Error("❌ Missing PRIVATE_KEY in .env");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const FLUSH_REWARDER_ABI = [
  "function flushEntryQueue()",
  "function rewardsOf(address) view returns (uint256)",
  "function claimRewards()",
  "function rewardsAvailable() view returns (uint256)"
];

const flushRewarder = new ethers.Contract(
  '0x7C9a7130379F1B5dd6e7A53AF84fC0fE32267B65',
  FLUSH_REWARDER_ABI,
  wallet
);

// --- Gas Configuration ---
async function getGasConfig(provider, strategy, addGwei = 2, percent = 20) {
  const feeData = await provider.getFeeData();

  const toBigInt = (value) => {
    if (value == null) return null;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'string') return BigInt(value);
    if (typeof value === 'number') return BigInt(Math.floor(value));
    return null;
  };

  let baseMaxPriority = 1_000_000_000n;
  let baseMaxFee = 2_000_000_000n;

  const maxPrio = toBigInt(feeData.maxPriorityFeePerGas);
  const maxFee = toBigInt(feeData.maxFeePerGas);

  if (maxPrio !== null) baseMaxPriority = maxPrio;
  if (maxFee !== null) baseMaxFee = maxFee;

  if ((maxFee === null || baseMaxFee === 0n) && feeData.gasPrice != null) {
    const gasPrice = toBigInt(feeData.gasPrice);
    if (gasPrice !== null) {
      baseMaxFee = gasPrice;
      baseMaxPriority = gasPrice / 2n;
    }
  }

  if (strategy === 'aggressive') {
    const addWei = BigInt(addGwei) * 1_000_000_000n;
    return {
      maxPriorityFeePerGas: baseMaxPriority + addWei,
      maxFeePerGas: baseMaxFee + addWei
    };
  }

  if (strategy === 'percent') {
    const increaseFactor = 100n + BigInt(percent);
    return {
      maxPriorityFeePerGas: (baseMaxPriority * increaseFactor) / 100n,
      maxFeePerGas: (baseMaxFee * increaseFactor) / 100n
    };
  }

  return {
    maxPriorityFeePerGas: baseMaxPriority,
    maxFeePerGas: baseMaxFee
  };
}

// --- Epoch Info (Uses BLOCK TIMESTAMP) ---
async function getEpochInfo() {
  const block = await provider.getBlock('latest');
  const currentTimestamp = block.timestamp;

  if (currentTimestamp < GENESIS_TIMESTAMP) {
    throw new Error("Aztec epoch has not started yet (before genesis).");
  }

  const elapsedTime = currentTimestamp - GENESIS_TIMESTAMP;
  const currentEpoch = Math.floor(elapsedTime / EPOCH_DURATION_SEC);
  const secondsIntoEpoch = elapsedTime % EPOCH_DURATION_SEC;
  const epochStartSec = GENESIS_TIMESTAMP + currentEpoch * EPOCH_DURATION_SEC;
  const epochEndSec = epochStartSec + EPOCH_DURATION_SEC;

  return {
    currentEpoch: BigInt(currentEpoch),
    epochStart: new Date(epochStartSec * 1000),
    epochEnd: new Date(epochEndSec * 1000),
    nextEpochStart: new Date(epochEndSec * 1000),
    isEarly: secondsIntoEpoch < EPOCH_WINDOW_SEC,
    secondsIntoEpoch
  };
}

// --- Flush Function ---
async function tryFlush(currentEpoch) {
  console.log(`🔍 Trying flush in epoch ${currentEpoch}...`);
  try {
    const beforeReward = await flushRewarder.rewardsOf(wallet.address);

    const strategy = (process.env.GAS_STRATEGY || 'auto').toLowerCase();
    const addGwei = parseInt(process.env.GAS_AGGRESSIVE_ADD_GWEI) || 2;
    const percent = parseInt(process.env.GAS_PERCENT_INCREASE) || 20;

    const gasConfig = await getGasConfig(provider, strategy, addGwei, percent);

    if (strategy !== 'auto') {
      const maxFeeGwei = ethers.formatUnits(gasConfig.maxFeePerGas || 0n, 'gwei');
      console.log(`⛽ Gas mode: ${strategy} | MaxFee: ${parseFloat(maxFeeGwei).toFixed(2)} Gwei`);
    }

    const tx = await flushRewarder.flushEntryQueue({
      gasLimit: 300000n,
      ...gasConfig
    });

    const receipt = await tx.wait();
    const gasCost = ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
    const afterReward = await flushRewarder.rewardsOf(wallet.address);
    const earned = afterReward - beforeReward;

    if (earned > 0n) {
      const earnedAZTEC = ethers.formatUnits(earned, 18);
      console.log(`🎉 Success! +${earnedAZTEC} $AZTEC | Gas: ${gasCost} ETH | Tx: ${tx.hash}`);
    } else {
      console.log(`ℹ️ Flush succeeded, but no reward earned.`);
    }

    return earned > 0n;
  } catch (e) {
    if (e.message.includes('no validators') || e.message.includes('already flushed')) {
      console.log('ℹ️ No validators in queue or already flushed.');
    } else {
      console.error('💥 Flush failed:', e.message);
    }
    return false;
  }
}

// --- Auto Claim ---
async function autoClaim() {
  try {
    const rewards = await flushRewarder.rewardsOf(wallet.address);
    if (rewards > 0n && rewards <= MAX_REWARD_TO_CLAIM) {
      const formatted = ethers.formatUnits(rewards, 18);
      console.log(`🪙 Claiming reward: ${formatted} $AZTEC`);
      const tx = await flushRewarder.claimRewards();
      await tx.wait();
      console.log('✅ Claim success!');
    } else if (rewards > MAX_REWARD_TO_CLAIM) {
      console.warn(`⚠️ Reward too large (${ethers.formatUnits(rewards, 18)} $AZTEC). Exceeds claim limit.`);
    }
  } catch (e) {
    console.error('⚠️ Failed to claim:', e.message);
  }
}

// --- Main Loop ---
async function runForever() {
  const GAS_STRATEGY = (process.env.GAS_STRATEGY || 'auto').toLowerCase();
  if (!['auto', 'aggressive', 'percent'].includes(GAS_STRATEGY)) {
    console.warn(`⚠️ Invalid GAS_STRATEGY: "${GAS_STRATEGY}". Use: auto, aggressive, or percent.`);
  }

  const ethBalance = await provider.getBalance(wallet.address);
  console.log(`🚀 Bot active | Wallet: ${wallet.address}`);
  console.log(`💰 ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);
  console.log(`⚙️  Gas Strategy: ${GAS_STRATEGY}`);
  console.log(`🛡️  Max Claim: ${ethers.formatEther(MAX_REWARD_TO_CLAIM)} $AZTEC`);
  console.log(`⏱️  Flush window: first ${EPOCH_WINDOW_SEC} seconds of each epoch\n`);

  let lastFlushedEpoch = -1n;

  while (true) {
    try {
      const nowLocal = new Date();
      const info = await getEpochInfo();

      // Read rewards & pool
      let rewardsAZTEC = "0.0";
      let poolAZTEC = "0.0";
      try {
        const r = await flushRewarder.rewardsOf(wallet.address);
        rewardsAZTEC = ethers.formatUnits(r, 18);
        const pool = await flushRewarder.rewardsAvailable();
        poolAZTEC = ethers.formatUnits(pool, 18);
      } catch (e) {
        console.error('Failed to read reward/pool status:', e.message);
      }

      // Simple countdown for display only
      const diffMs = info.nextEpochStart.getTime() - Date.now();
      const countdown = diffMs <= 0 ? "Now!" : `${Math.ceil(diffMs / 1000)}s`;

      console.log(
        `[${nowLocal.toLocaleTimeString()}] 📊 Epoch ${info.currentEpoch}\n` +
        `   💰 Your rewards : ${rewardsAZTEC} $AZTEC\n` +
        `   🏦 Reward Pool  : ${poolAZTEC} $AZTEC\n` +
        `   🕒 START        : ${info.epochStart.toLocaleTimeString()}\n` +
        `   🕔 END          : ${info.epochEnd.toLocaleTimeString()}\n` +
        `   ⏳ Next flush in: ${countdown}\n`
      );

      // Always claim if there's unclaimed reward
      if (rewardsAZTEC !== "0.0") {
        await autoClaim();
      }

      // Flush ONLY if:
      // 1. We're in the first 15s of the epoch (on-chain time)
      // 2. We haven't flushed this epoch yet
      if (info.isEarly && info.currentEpoch !== lastFlushedEpoch) {
        await tryFlush(info.currentEpoch);
        await autoClaim(); // claim immediately after flush if any
        lastFlushedEpoch = info.currentEpoch;
      }

    } catch (e) {
      console.error('❌ Main loop error:', e.message);
    }

    // Wait before next check
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

runForever().catch(console.error);
