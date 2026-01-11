// run.mjs - Aztec Flush Bot with Multi-Mode Gas, Safe Gas, & Reward-Aware Flush
import { ethers } from 'ethers';
import 'dotenv/config';

const BLOCKS_PER_EPOCH = 192n;
const EPOCH_WINDOW_SEC = 15; 
const CHECK_INTERVAL_MS = 30_000;
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

async function getEpochInfo() {
  const block = await provider.getBlock('latest');
  const currentBlock = BigInt(block.number);
  const currentEpoch = currentBlock / BLOCKS_PER_EPOCH;
  const blocksIntoEpoch = currentBlock % BLOCKS_PER_EPOCH;
  const secondsIntoEpoch = Number(blocksIntoEpoch) * 12;

  const epochStartSec = block.timestamp - secondsIntoEpoch;
  const epochEndSec = epochStartSec + Number(BLOCKS_PER_EPOCH) * 12;
  const nextEpochStart = new Date(epochEndSec * 1000);

  return {
    currentEpoch,
    epochStart: new Date(epochStartSec * 1000),
    epochEnd: new Date(epochEndSec * 1000),
    nextEpochStart,
    isEarly: secondsIntoEpoch < EPOCH_WINDOW_SEC,
    blocksIntoEpoch
  };
}

function formatCountdown(nextEpochStart) {
  const now = Date.now();
  const diffMs = nextEpochStart.getTime() - now;
  if (diffMs <= 0) return "Segera!";

  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} detik`;
  if (totalSeconds < 3600) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins} minutes ${secs} seconds`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours} hours`;
}

async function tryFlush(currentEpoch) {
  console.log(`🔍 trying flush in epoch ${currentEpoch}...`);
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
      gasLimit: 300000,
      ...gasConfig
    });

    const receipt = await tx.wait();
    const gasCost = ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
    const afterReward = await flushRewarder.rewardsOf(wallet.address);
    const earned = afterReward - beforeReward;

    if (earned > 0n) {
      const earnedAZTEC = ethers.formatUnits(earned, 18);
      console.log(`🎉 success! +${earnedAZTEC} $AZTEC | Gas: ${gasCost} ETH | Tx: ${tx.hash}`);
    } else {
      console.log(`ℹ️ Flush success, no have reward.`);
    }

    return earned > 0n;
  } catch (e) {
    if (e.message.includes('no validators') || e.message.includes('already flushed')) {
      console.log('ℹ️ no validator or already flushed.');
    } else {
      console.error('💥 Flush failed:', e.message);
    }
    return false;
  }
}

async function autoClaim() {
  try {
    const rewards = await flushRewarder.rewardsOf(wallet.address);
    if (rewards > 0n && rewards <= MAX_REWARD_TO_CLAIM) {
      const formatted = ethers.formatUnits(rewards, 18);
      console.log(`🪙 Klaim reward: ${formatted} $AZTEC`);
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
const ethBalance = await provider.getBalance(wallet.address);

async function runForever() {
  const GAS_STRATEGY = (process.env.GAS_STRATEGY || 'auto').toLowerCase();
  if (!['auto', 'aggressive', 'percent'].includes(GAS_STRATEGY)) {
    console.warn(`⚠️ GAS_STRATEGY not valid: "${GAS_STRATEGY}". try: auto, aggressive, or percent.`);
  }

  console.log(`🚀 Bot aktif | Wallet: ${wallet.address}`);
  console.log(`💰 Balance ETH: ${ethers.formatEther(ethBalance)} ETH`);
  console.log(`⚙️  Strategi Gas: ${GAS_STRATEGY}`);
  console.log(`🛡️  Max claim: ${ethers.formatEther(MAX_REWARD_TO_CLAIM)} $AZTEC`);
  console.log(`⏱️  Flush in: ${EPOCH_WINDOW_SEC} seconds early epoch\n`);

  while (true) {
    try {
      const now = new Date();
      const info = await getEpochInfo();

      let rewardsAZTEC = "0.0";
      let poolAZTEC = "0.0";
      try {
        const r = await flushRewarder.rewardsOf(wallet.address);
        rewardsAZTEC = ethers.formatUnits(r, 18);
        const pool = await flushRewarder.rewardsAvailable();
        poolAZTEC = ethers.formatUnits(pool, 18);
      } catch (e) {
        console.error('Gagal read status reward/pool:', e.message);
      }

      const countdown = formatCountdown(info.nextEpochStart);

      console.log(
        `[${now.toLocaleTimeString()}] 📊 Epoch ${info.currentEpoch}\n` +
        `   💰 your rewards : ${rewardsAZTEC} $AZTEC\n` +
        `   🏦 rewards Pool: ${poolAZTEC} $AZTEC\n` +
        `   🕒 START     : ${info.epochStart.toLocaleTimeString()}\n` +
        `   🕔 END       : ${info.epochEnd.toLocaleTimeString()}\n` +
        `   ⏳ Flush in ${countdown}\n`
      );

      if (rewardsAZTEC !== "0.0") {
        await autoClaim();
      }

      if (info.isEarly) {
        await tryFlush(info.currentEpoch);
        await autoClaim();
      }

    } catch (e) {
      console.error('❌ Error main:', e.message);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

runForever().catch(console.error);
