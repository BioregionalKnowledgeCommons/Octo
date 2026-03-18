import "dotenv/config";
import { ethers } from "ethers";

// Minimal ABIs for swap execution
const ERC20_ABI = [
  {
    inputs: [
      { internalType: "address", name: "_spender", type: "address" },
      { internalType: "uint256", name: "_value", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const SWAP_POOL_ABI = [
  // getQuote (NOT view — must use staticCall)
  {
    inputs: [
      { internalType: "address", name: "_outToken", type: "address" },
      { internalType: "address", name: "_inToken", type: "address" },
      { internalType: "uint256", name: "_value", type: "uint256" },
    ],
    name: "getQuote",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  // withdraw (swap: outToken, inToken, value, deduct_fee)
  {
    inputs: [
      { internalType: "address", name: "_outToken", type: "address" },
      { internalType: "address", name: "_inToken", type: "address" },
      { internalType: "uint256", name: "_value", type: "uint256" },
      { internalType: "bool", name: "_deduct_fee", type: "bool" },
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // deposit
  {
    inputs: [
      { internalType: "address", name: "_token", type: "address" },
      { internalType: "uint256", name: "_value", type: "uint256" },
    ],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Swap event
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "initiator", type: "address" },
      { indexed: true, internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
      { internalType: "uint256", name: "amountOut", type: "uint256" },
      { internalType: "uint256", name: "fee", type: "uint256" },
    ],
    name: "Swap",
    type: "event",
  },
] as const;

// --- Config ---
const CELO_RPC = process.env.CELO_RPC_URL || "https://forno.celo.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const POOL_ADDRESS = process.env.SWAP_POOL_ADDRESS;
const VCV_ADDRESS = process.env.VCV_TOKEN_ADDRESS;
const CUSD_ADDRESS = "0x765DE816845861e75A25fCA122bb6898B8B1282a";
const KOI_BASE = process.env.KOI_API_BASE_URL || "http://localhost:8351";

function getSigner(): ethers.Wallet {
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const provider = new ethers.JsonRpcProvider(CELO_RPC);
  return new ethers.Wallet(key, provider);
}

// --- Quote ---

async function quote(amount: string, direction: "vcv-to-cusd" | "cusd-to-vcv"): Promise<void> {
  if (!POOL_ADDRESS || !VCV_ADDRESS) {
    console.error("Error: SWAP_POOL_ADDRESS and VCV_TOKEN_ADDRESS must be set in .env");
    process.exit(1);
  }

  const signer = getSigner();
  const pool = new ethers.Contract(POOL_ADDRESS, SWAP_POOL_ABI, signer);

  let outToken: string, inToken: string, inDecimals: number, outDecimals: number;
  let inSymbol: string, outSymbol: string;

  if (direction === "vcv-to-cusd") {
    outToken = CUSD_ADDRESS;
    inToken = VCV_ADDRESS;
    inDecimals = 6;
    outDecimals = 18;
    inSymbol = "VCV";
    outSymbol = "cUSD";
  } else {
    outToken = VCV_ADDRESS;
    inToken = CUSD_ADDRESS;
    inDecimals = 18;
    outDecimals = 6;
    inSymbol = "cUSD";
    outSymbol = "VCV";
  }

  const inAmount = ethers.parseUnits(amount, inDecimals);
  const quoteResult = await pool.getQuote.staticCall(outToken, inToken, inAmount);

  console.log(`\nQuote: ${amount} ${inSymbol} → ${ethers.formatUnits(quoteResult, outDecimals)} ${outSymbol}`);
  console.log(`Pool: ${POOL_ADDRESS}`);
}

// --- Swap ---

async function swap(amount: string, direction: "vcv-to-cusd" | "cusd-to-vcv"): Promise<void> {
  if (!POOL_ADDRESS || !VCV_ADDRESS) {
    console.error("Error: SWAP_POOL_ADDRESS and VCV_TOKEN_ADDRESS must be set in .env");
    process.exit(1);
  }

  const signer = getSigner();
  const address = await signer.getAddress();
  const pool = new ethers.Contract(POOL_ADDRESS, SWAP_POOL_ABI, signer);

  let outToken: string, inToken: string, inDecimals: number, outDecimals: number;
  let inSymbol: string, outSymbol: string;

  if (direction === "vcv-to-cusd") {
    outToken = CUSD_ADDRESS;
    inToken = VCV_ADDRESS;
    inDecimals = 6;
    outDecimals = 18;
    inSymbol = "VCV";
    outSymbol = "cUSD";
  } else {
    outToken = VCV_ADDRESS;
    inToken = CUSD_ADDRESS;
    inDecimals = 18;
    outDecimals = 6;
    inSymbol = "cUSD";
    outSymbol = "VCV";
  }

  const inAmount = ethers.parseUnits(amount, inDecimals);

  // 1. Get quote first
  const quoteResult = await pool.getQuote.staticCall(outToken, inToken, inAmount);
  console.log(`\n=== Executing Swap ===`);
  console.log(`${amount} ${inSymbol} → ${ethers.formatUnits(quoteResult, outDecimals)} ${outSymbol}`);

  // 2. Approve pool to spend inToken
  const inTokenContract = new ethers.Contract(inToken, ERC20_ABI, signer);
  console.log(`\nApproving ${inSymbol}...`);
  const approveTx = await inTokenContract.approve(POOL_ADDRESS, inAmount);
  await approveTx.wait();

  // 3. Deposit inToken into pool
  console.log(`Depositing ${amount} ${inSymbol} into pool...`);
  const depositTx = await pool.deposit(inToken, inAmount);
  await depositTx.wait();

  // 4. Withdraw outToken (this is the swap)
  console.log(`Withdrawing ${outSymbol}...`);
  const withdrawTx = await (pool as any)["withdraw(address,address,uint256,bool)"](
    outToken,
    inToken,
    inAmount,
    false, // don't deduct fee (fee is 0 anyway)
  );
  const receipt = await withdrawTx.wait();

  // 5. Parse Swap event
  const swapIface = new ethers.Interface(SWAP_POOL_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = swapIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "Swap") {
        console.log(`\nSwap event:`);
        console.log(`  In: ${ethers.formatUnits(parsed.args.amountIn, inDecimals)} ${inSymbol}`);
        console.log(`  Out: ${ethers.formatUnits(parsed.args.amountOut, outDecimals)} ${outSymbol}`);
        console.log(`  Fee: ${parsed.args.fee}`);
      }
    } catch {
      // Not a Swap event
    }
  }

  console.log(`\nTX: ${withdrawTx.hash}`);
  console.log(`Block: ${receipt.blockNumber}`);

  // 6. Show updated balances
  const vcvToken = new ethers.Contract(VCV_ADDRESS, ERC20_ABI, signer);
  const cusdToken = new ethers.Contract(CUSD_ADDRESS, ERC20_ABI, signer);
  const vcvBal = await vcvToken.balanceOf(address);
  const cusdBal = await cusdToken.balanceOf(address);
  console.log(`\nWallet balances:`);
  console.log(`  VCV: ${ethers.formatUnits(vcvBal, 6)}`);
  console.log(`  cUSD: ${ethers.formatUnits(cusdBal, 18)}`);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log("Usage:");
    console.log("  npx tsx execute-swap.ts --quote <amount>                    Quote VCV→cUSD");
    console.log("  npx tsx execute-swap.ts --quote <amount> --direction cusd   Quote cUSD→VCV");
    console.log("  npx tsx execute-swap.ts --swap <amount>                     Swap VCV→cUSD");
    console.log("  npx tsx execute-swap.ts --swap <amount> --direction cusd    Swap cUSD→VCV");
    process.exit(0);
  }

  const direction: "vcv-to-cusd" | "cusd-to-vcv" = args.includes("--direction") &&
    args[args.indexOf("--direction") + 1] === "cusd"
    ? "cusd-to-vcv"
    : "vcv-to-cusd";

  if (args.includes("--quote")) {
    const amount = args[args.indexOf("--quote") + 1] || "100";
    await quote(amount, direction);
    return;
  }

  if (args.includes("--swap")) {
    const amount = args[args.indexOf("--swap") + 1] || "100";
    await swap(amount, direction);
    return;
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
