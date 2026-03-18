import "dotenv/config";
import { ethers } from "ethers";

// Well-known Celo mainnet addresses
const CELO_TOKEN = "0x471EcE3750Da237f93B8E339c536989b8978a438"; // GoldToken (ERC-20 wrapper)
const CUSD_TOKEN = "0x765DE816845861e75A25fCA122bb6898B8B1282a";

// Mento V2 Broker + BiPoolManager on Celo mainnet (EIP-55 checksums)
const MENTO_BROKER = "0x777a8255Ca72Cd0A26D0a0F2C5Ba37F64Ccd0388";

// Uniswap V3 SwapRouter on Celo (fallback)
const UNISWAP_ROUTER = "0x5615CDAb10dc425a742d643d949a7F474C01abc4";

const ERC20_ABI = [
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
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

// Mento Broker ABI (subset)
const BROKER_ABI = [
  {
    inputs: [
      { internalType: "address", name: "exchangeProvider", type: "address" },
      { internalType: "bytes32", name: "exchangeId", type: "bytes32" },
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
      { internalType: "uint256", name: "amountOutMin", type: "uint256" },
    ],
    name: "swapIn",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "exchangeProvider", type: "address" },
      { internalType: "bytes32", name: "exchangeId", type: "bytes32" },
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
    ],
    name: "getAmountOut",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getExchangeProviders",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// BiPoolManager ABI (subset for exchange discovery)
const BIPOOL_ABI = [
  {
    inputs: [],
    name: "getExchanges",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "exchangeId", type: "bytes32" },
          {
            components: [
              { internalType: "address", name: "asset0", type: "address" },
              { internalType: "address", name: "asset1", type: "address" },
            ],
            internalType: "struct IExchangeProvider.Exchange[]",
            name: "assets",
            type: "tuple[]",
          },
        ],
        internalType: "struct IBiPoolManager.PoolExchange[]",
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Uniswap V3 SwapRouter ABI (fallback)
const UNISWAP_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint24", name: "fee", type: "uint24" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "uint256", name: "deadline", type: "uint256" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
          { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        internalType: "struct ISwapRouter.ExactInputSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

// --- Config ---

const CELO_RPC = process.env.CELO_RPC_URL || "https://forno.celo.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

function getSigner(): ethers.Wallet {
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  return new ethers.Wallet(key, new ethers.JsonRpcProvider(CELO_RPC));
}

// --- Check balances ---

async function check(): Promise<void> {
  const signer = getSigner();
  const address = await signer.getAddress();

  const celoBalance = await signer.provider!.getBalance(address);
  const celoToken = new ethers.Contract(CELO_TOKEN, ERC20_ABI, signer);
  const celoErc20Bal = await celoToken.balanceOf(address);
  const cusdToken = new ethers.Contract(CUSD_TOKEN, ERC20_ABI, signer);
  const cusdBal = await cusdToken.balanceOf(address);

  console.log(`\nAddress: ${address}`);
  console.log(`Native CELO: ${ethers.formatEther(celoBalance)}`);
  console.log(`CELO (ERC-20): ${ethers.formatEther(celoErc20Bal)}`);
  console.log(`cUSD: ${ethers.formatEther(cusdBal)}`);
}

// --- Swap CELO → cUSD via Mento ---

async function swapViaMento(amountCelo: string): Promise<boolean> {
  const signer = getSigner();
  const address = await signer.getAddress();
  const amountIn = ethers.parseEther(amountCelo);

  console.log(`\n=== Mento: Swapping ${amountCelo} CELO → cUSD ===\n`);

  const broker = new ethers.Contract(MENTO_BROKER, BROKER_ABI, signer);

  // Discover exchange providers
  let providers: string[];
  try {
    providers = await broker.getExchangeProviders();
    console.log(`Exchange providers: ${providers.length}`);
  } catch (e: any) {
    console.log(`Mento Broker not accessible: ${e.message?.slice(0, 80)}`);
    return false;
  }

  // Find CELO/cUSD exchange
  let exchangeId: string | null = null;
  let exchangeProvider: string | null = null;

  for (const provAddr of providers) {
    try {
      const biPool = new ethers.Contract(provAddr, BIPOOL_ABI, signer);
      const exchanges = await biPool.getExchanges();
      for (const ex of exchanges) {
        const assets = ex.assets || ex[1];
        for (const asset of assets) {
          const a0 = (asset.asset0 || asset[0]).toLowerCase();
          const a1 = (asset.asset1 || asset[1]).toLowerCase();
          if (
            (a0 === CELO_TOKEN.toLowerCase() && a1 === CUSD_TOKEN.toLowerCase()) ||
            (a1 === CELO_TOKEN.toLowerCase() && a0 === CUSD_TOKEN.toLowerCase())
          ) {
            exchangeId = ex.exchangeId || ex[0];
            exchangeProvider = provAddr;
            console.log(`Found CELO/cUSD exchange: ${exchangeId}`);
            break;
          }
        }
        if (exchangeId) break;
      }
    } catch (e: any) {
      console.log(`  Provider ${provAddr}: ${e.message?.slice(0, 60)}`);
    }
    if (exchangeId) break;
  }

  if (!exchangeId || !exchangeProvider) {
    console.log("CELO/cUSD exchange not found via Mento");
    return false;
  }

  // Get quote
  try {
    const quote = await broker.getAmountOut(exchangeProvider, exchangeId, CELO_TOKEN, CUSD_TOKEN, amountIn);
    console.log(`Quote: ${amountCelo} CELO → ${ethers.formatEther(quote)} cUSD`);
  } catch (e: any) {
    console.log(`getAmountOut failed: ${e.message?.slice(0, 80)}`);
    return false;
  }

  // Approve CELO token for Broker
  console.log("Approving CELO for Broker...");
  const celoToken = new ethers.Contract(CELO_TOKEN, ERC20_ABI, signer);
  const approveTx = await celoToken.approve(MENTO_BROKER, amountIn);
  await approveTx.wait();

  // Swap
  console.log("Executing swapIn...");
  const swapTx = await broker.swapIn(
    exchangeProvider,
    exchangeId,
    CELO_TOKEN,
    CUSD_TOKEN,
    amountIn,
    0, // amountOutMin = 0 for demo (small amount)
  );
  console.log(`TX: ${swapTx.hash}`);
  const receipt = await swapTx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  // Check result
  const cusdToken = new ethers.Contract(CUSD_TOKEN, ERC20_ABI, signer);
  const cusdBal = await cusdToken.balanceOf(address);
  console.log(`\ncUSD balance: ${ethers.formatEther(cusdBal)}`);

  return true;
}

// --- Swap CELO → cUSD via Uniswap V3 (fallback) ---

async function swapViaUniswap(amountCelo: string): Promise<boolean> {
  const signer = getSigner();
  const address = await signer.getAddress();
  const amountIn = ethers.parseEther(amountCelo);

  console.log(`\n=== Uniswap V3: Swapping ${amountCelo} CELO → cUSD ===\n`);

  // Approve CELO token for router
  const celoToken = new ethers.Contract(CELO_TOKEN, ERC20_ABI, signer);
  console.log("Approving CELO for Uniswap...");
  const approveTx = await celoToken.approve(UNISWAP_ROUTER, amountIn);
  await approveTx.wait();

  const router = new ethers.Contract(UNISWAP_ROUTER, UNISWAP_ABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + 300;

  // Try multiple fee tiers — CELO/cUSD pool may be at any of these
  const feeTiers = [100, 500, 3000, 10000];
  for (const fee of feeTiers) {
    try {
      console.log(`Trying fee tier ${fee} (${fee / 10000}%)...`);
      const swapTx = await router.exactInputSingle({
        tokenIn: CELO_TOKEN,
        tokenOut: CUSD_TOKEN,
        fee,
        recipient: address,
        deadline,
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      });
      console.log(`TX: ${swapTx.hash}`);
      const receipt = await swapTx.wait();
      console.log(`Confirmed in block ${receipt.blockNumber}`);

      const cusdToken = new ethers.Contract(CUSD_TOKEN, ERC20_ABI, signer);
      const cusdBal = await cusdToken.balanceOf(address);
      console.log(`\ncUSD balance: ${ethers.formatEther(cusdBal)}`);
      return true;
    } catch (e: any) {
      console.log(`  Fee ${fee}: failed (${e.message?.slice(0, 60)})`);
    }
  }
  return false;
}

// --- Swap CELO → cUSD via Ubeswap V2 (Celo's native DEX) ---

const UBESWAP_ROUTER = "0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121";

const UBESWAP_ABI = [
  {
    inputs: [
      { internalType: "uint256", name: "amountIn", type: "uint256" },
      { internalType: "uint256", name: "amountOutMin", type: "uint256" },
      { internalType: "address[]", name: "path", type: "address[]" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
    ],
    name: "swapExactTokensForTokens",
    outputs: [{ internalType: "uint256[]", name: "amounts", type: "uint256[]" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountIn", type: "uint256" },
      { internalType: "address[]", name: "path", type: "address[]" },
    ],
    name: "getAmountsOut",
    outputs: [{ internalType: "uint256[]", name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

async function swapViaUbeswap(amountCelo: string): Promise<boolean> {
  const signer = getSigner();
  const address = await signer.getAddress();
  const amountIn = ethers.parseEther(amountCelo);

  console.log(`\n=== Ubeswap V2: Swapping ${amountCelo} CELO → cUSD ===\n`);

  const router = new ethers.Contract(UBESWAP_ROUTER, UBESWAP_ABI, signer);
  const path = [CELO_TOKEN, CUSD_TOKEN];
  const deadline = Math.floor(Date.now() / 1000) + 300;

  // Get quote first
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    console.log(`Quote: ${amountCelo} CELO → ${ethers.formatEther(amounts[1])} cUSD`);
  } catch (e: any) {
    console.log(`Ubeswap quote failed: ${e.message?.slice(0, 80)}`);
    return false;
  }

  // Approve
  const celoToken = new ethers.Contract(CELO_TOKEN, ERC20_ABI, signer);
  console.log("Approving CELO for Ubeswap...");
  const approveTx = await celoToken.approve(UBESWAP_ROUTER, amountIn);
  await approveTx.wait();

  // Swap
  try {
    console.log("Executing swap...");
    const swapTx = await router.swapExactTokensForTokens(
      amountIn,
      0, // amountOutMin = 0 for demo (small amount)
      path,
      address,
      deadline,
    );
    console.log(`TX: ${swapTx.hash}`);
    const receipt = await swapTx.wait();
    console.log(`Confirmed in block ${receipt.blockNumber}`);

    const cusdToken = new ethers.Contract(CUSD_TOKEN, ERC20_ABI, signer);
    const cusdBal = await cusdToken.balanceOf(address);
    console.log(`\ncUSD balance: ${ethers.formatEther(cusdBal)}`);
    return true;
  } catch (e: any) {
    console.log(`Ubeswap swap failed: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log("Usage:");
    console.log("  npx tsx acquire-cusd.ts --amount 5       Swap 5 CELO for ~5 cUSD");
    console.log("  npx tsx acquire-cusd.ts --check           Show CELO + cUSD balances");
    process.exit(0);
  }

  if (args.includes("--check")) {
    await check();
    return;
  }

  if (args.includes("--amount")) {
    const amount = args[args.indexOf("--amount") + 1] || "5";
    console.log(`Acquiring cUSD by swapping ${amount} CELO...`);

    // Try Mento first, then Ubeswap, then Uniswap V3
    let success = await swapViaMento(amount);

    if (!success) {
      console.log("\nMento failed, trying Ubeswap V2...");
      success = await swapViaUbeswap(amount);
    }

    if (!success) {
      console.log("\nUbeswap failed, trying Uniswap V3...");
      success = await swapViaUniswap(amount);
    }

    if (!success) {
      console.error("\nAll swap methods failed. Manual options:");
      console.error("  1. Use a DEX UI (app.ubeswap.org)");
      console.error("  2. Transfer cUSD from another wallet");
      process.exit(1);
    }
    return;
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
