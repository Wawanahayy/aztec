// aztec-flush.mjs - Multi-Mode Flush Bot (slot-based, ETH Mainnet compatible)
import { ethers } from 'ethers';
import 'dotenv/config';

const CHECK_INTERVAL_MS = 1000;
const MAX_REWARD_TO_CLAIM = 1000n * 10n ** 18n; // 1000 AZTEC

const FLUSH_MODE = (process.env.FLUSH_MODE || 'pre').toLowerCase();
const PRE_SEND_SECONDS = parseInt(process.env.PRE_SEND_SECONDS || '3');
const EPOCH_WINDOW_SEC = parseInt(process.env.FLUSH_VALID || '15'); // valid flush window in seconds

if (!['local', 'pre', 'block'].includes(FLUSH_MODE)) {
  throw new Error('❌ Invalid FLUSH_MODE. Use: local, pre, or block');
}


const FLUSH_ADDR = '0x7C9a7130379F1B5dd6e7A53AF84fC0fE32267B65';
const ROLLUP_ADDR = '0x603bb2c05D474794ea97805e8De69bCcFb3bCA12';


const READ_RPC_URL = process.env.READ_RPC_URL || process.env.RPC_URL;
const WRITE_RPC_URL = process.env.WRITE_RPC_URL || process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!READ_RPC_URL) throw new Error("❌ Missing READ_RPC_URL");
if (!WRITE_RPC_URL) throw new Error("❌ Missing WRITE_RPC_URL");
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE_KEY");

// ── Provider & Wallet ──────────────────────────────────────
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
  "function getEpochDuration() view returns (uint256)", // ⚠️ JUMLAH SLOT per epoch!
  "function getActiveAttesterCount() view returns (uint256)",
  "function isRewardsClaimable() view returns (bool)"
];

// ── Kontrak ────────────────────────────────────────────────
const flushRead = new ethers.Contract(FLUSH_ADDR, FLUSH_ABI, readProvider);
const flushWrite = new ethers.Contract(FLUSH_ADDR, FLUSH_ABI, wallet);
const rollupRead = new ethers.Contract(ROLLUP_ADDR, ROLLUP_ABI, readProvider);

// ── Helper ─────────────────────────────────────────────────
const toBigInt = (val) => {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string') return BigInt(val);
  if (typeof val === 'number') return BigInt(Math.floor(val));
  if (val && val._hex) return BigInt(val._hex);
  return 0n;
};

// ── Baca state on-chain lengkap ────────────────────────────
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

  const slotDur = toBigInt(slotDurationSec);
  const slotsPerEp = toBigInt(slotsPerEpoch);
  const epochNum = slotsPerEp > 0n ? currentSlot / slotsPerEp : 0n;
  const slotsIntoEpoch = currentSlot % slotsPerEp;
  const secondsIntoEpoch = slotsIntoEpoch * slotDur;

  return {
    blockNumber: null, // akan diisi nanti
    currentSlot: toBigInt(currentSlot),
    slotDurationSec: slotDur,
    slotsPerEpoch: slotsPerEp,
    epochNum,
    slotsIntoEpoch,
    secondsIntoEpoch,
    activeAttesters: toBigInt(activeAttesters),
    isClaimable,
    userReward: toBigInt(userReward),
    poolReward: toBigInt(poolReward)
  };
}

// ── Flush Function ─────────────────────────────────────────
async function tryFlush(epochNum) {
  try {
    const startBlock = await writeProvider.getBlockNumber();
    const timeString = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`🔍 Flushing epoch ${epochNum} at ${timeString} | Start block: ${startBlock}`);

    const before = await flushRead.rewardsOf(wallet.address);
    const beforeBigInt = toBigInt(before);

    const feeData = await writeProvider.getFeeData();
    let maxFee = feeData.maxFeePerGas ? toBigInt(feeData.maxFeePerGas) : 2_000_000_000n;
    let maxPrio = feeData.maxPriorityFeePerGas ? toBigInt(feeData.maxPriorityFeePerGas) : 1_000_000_000n;
    maxFee = (maxFee * 130n) / 100n;
    maxPrio = (maxPrio * 130n) / 100n;

    const tx = await flushWrite.flushEntryQueue({
      gasLimit: 300000n,
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
      const tx = await flushWrite.claimRewards();
      await tx.wait();
      console.log('✅ Claim success!');
    }
  } catch (e) {
    console.error('⚠️ Claim failed:', e.message);
  }
}

// ── Format waktu ───────────────────────────────────────────
function formatTimeRemaining(seconds) {
  if (seconds <= 0) return "Now!";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

// ── Main Loop ──────────────────────────────────────────────
async function run() {
  const balance = await readProvider.getBalance(wallet.address);
  console.log(`🚀 Bot active | Wallet: ${wallet.address}`);
  console.log(`💰 ETH Balance: ${ethers.formatEther(balance)} ETH`);
  console.log(`📡 Read RPC: ${READ_RPC_URL.replace(/(.*)(.{4})$/, '***$2')}`);
  console.log(`📤 Write RPC: ${WRITE_RPC_URL.replace(/(.*)(.{4})$/, '***$2')}`);
  console.log(`⏱️  Flush mode: ${FLUSH_MODE}${FLUSH_MODE === 'pre' ? ` (send ${PRE_SEND_SECONDS}s early)` : ''}`);
  console.log(`⏱️  Flush window: first ${EPOCH_WINDOW_SEC} seconds of epoch (on-chain)\n`);

  let lastFlushedEpoch = -1n;

  while (true) {
    try {
      const block = await readProvider.getBlock('latest');
      const state = await getOnChainState();
      state.blockNumber = block.number;

      const {
        epochNum,
        secondsIntoEpoch,
        slotsIntoEpoch,
        slotDurationSec,
        slotsPerEpoch,
        activeAttesters,
        isClaimable,
        userReward,
        poolReward
      } = state;

      const rewardsAZTEC = ethers.formatUnits(userReward, 18);
      const poolAZTEC = ethers.formatUnits(poolReward, 18);

      // Prediksi waktu ke epoch berikutnya (untuk mode 'pre')
      const slotsUntilNextEpoch = slotsPerEpoch - slotsIntoEpoch;
      const secondsUntilNextEpoch = Number(slotsUntilNextEpoch * slotDurationSec);
      const realtimeCountdown = formatTimeRemaining(secondsUntilNextEpoch);

      console.log(
        `[${new Date().toLocaleTimeString()}] 📊 Epoch ${epochNum.toString()}\n` +
        `   💰 Your rewards : ${rewardsAZTEC} $AZTEC\n` +
        `   🏦 Reward Pool  : ${poolAZTEC} $AZTEC\n` +
        `   👥 Attesters    : ${activeAttesters.toString()}\n` +
        `   🧮 Slot         : ${state.currentSlot.toString()} (${slotsIntoEpoch.toString()} into epoch)\n` +
        `   ⏱️ On-chain     : ${secondsIntoEpoch.toString()}s into epoch\n` +
        `   ⏳ Next epoch in: ${realtimeCountdown} (${secondsUntilNextEpoch}s)\n`
      );

      if (userReward > 0n) await autoClaim();

      // ── LOGIKA FLUSH BERDASARKAN MODE ───────────────────────
      let shouldFlush = false;
      let flushReason = "";

      if (FLUSH_MODE === 'block') {
        // Reaktif: flush jika on-chain secondsIntoEpoch dalam window
        if (secondsIntoEpoch <= BigInt(EPOCH_WINDOW_SEC) && epochNum !== lastFlushedEpoch) {
          shouldFlush = true;
          flushReason = "on-chain time in flush window";
        }
      } else if (FLUSH_MODE === 'local') {
        // Gunakan estimasi lokal (tidak disarankan, tapi tetap didukung)
        const localSecondsInto = secondsIntoEpoch; // fallback ke on-chain karena tidak ada genesis
        if (localSecondsInto <= BigInt(EPOCH_WINDOW_SEC) && epochNum !== lastFlushedEpoch) {
          shouldFlush = true;
          flushReason = "local estimate in window";
        }
      } else if (FLUSH_MODE === 'pre') {
        // Kirim X detik sebelum epoch baru dimulai
        if (secondsUntilNextEpoch <= PRE_SEND_SECONDS && epochNum !== lastFlushedEpoch) {
          shouldFlush = true;
          flushReason = `pre-send (${secondsUntilNextEpoch}s before next epoch)`;
        }
      }

      if (shouldFlush) {
        console.log(`🎯 Flush triggered: ${flushReason}`);
        await tryFlush(epochNum);
        await autoClaim();
        lastFlushedEpoch = epochNum;
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
