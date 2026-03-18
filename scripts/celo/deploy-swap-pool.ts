import "dotenv/config";
import { ethers } from "ethers";

// Minimal SwapPool ABI — functions we actually call
const SWAP_POOL_ABI = [
  // Constructor
  {
    inputs: [
      { internalType: "string", name: "_name", type: "string" },
      { internalType: "string", name: "_symbol", type: "string" },
      { internalType: "uint8", name: "_decimals", type: "uint8" },
      { internalType: "address", name: "_tokenRegistry", type: "address" },
      { internalType: "address", name: "_tokenLimiter", type: "address" },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  // Views
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
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
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "quoter",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "feePpm",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "feeAddress",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "tokenRegistry",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "tokenLimiter",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  // Owner-only setup
  {
    inputs: [{ internalType: "address", name: "_quoter", type: "address" }],
    name: "setQuoter",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_fee", type: "uint256" }],
    name: "setFee",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_feeAddress", type: "address" }],
    name: "setFeeAddress",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Deposit
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
  // Deposit event
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "initiator", type: "address" },
      { indexed: true, internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
    ],
    name: "Deposit",
    type: "event",
  },
  // fees mapping
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "fees",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Minimal DecimalQuote ABI
const DECIMAL_QUOTE_ABI = [
  {
    inputs: [
      { internalType: "address", name: "_outToken", type: "address" },
      { internalType: "address", name: "_inToken", type: "address" },
      { internalType: "uint256", name: "_value", type: "uint256" },
    ],
    name: "valueFor",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ERC-20 approve ABI
const ERC20_APPROVE_ABI = [
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
] as const;

// Bytecodes are read from files at deploy time (too large to embed inline).
import * as fs from "fs";
import * as path from "path";

function readBytecodeFile(filename: string): string {
  // Try local abi/ dir first, then GE repo path
  const localPath = path.join(__dirname, "abi", filename);
  const gePath = path.join(
    process.env.HOME || "",
    "projects/grassroots-economics/erc20-pool/python/erc20_pool/data",
    filename,
  );

  for (const p of [localPath, gePath]) {
    if (fs.existsSync(p)) {
      const hex = fs.readFileSync(p, "utf-8").trim();
      return hex.startsWith("0x") ? hex : `0x${hex}`;
    }
  }
  throw new Error(
    `Bytecode file ${filename} not found. Place in ./abi/ or ensure grassroots-economics/erc20-pool is at ~/projects/`,
  );
}

// --- Config ---
const CELO_RPC = process.env.CELO_RPC_URL || "https://forno.celo.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VCV_TOKEN_ADDRESS = process.env.VCV_TOKEN_ADDRESS;
const CUSD_ADDRESS = "0x765DE816845861e75A25fCA122bb6898B8B1282a"; // Celo mainnet cUSD

function getSigner(): ethers.Wallet {
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const provider = new ethers.JsonRpcProvider(CELO_RPC);
  return new ethers.Wallet(key, provider);
}

// --- Deploy ---

async function deploy(): Promise<void> {
  console.log("\n=== Deploying BKC SwapPool on Celo Mainnet ===\n");

  const signer = getSigner();
  const address = await signer.getAddress();
  const balance = await signer.provider!.getBalance(address);
  console.log(`Deployer: ${address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} CELO`);

  if (balance === 0n) {
    console.error("Error: Wallet has no CELO for gas");
    process.exit(1);
  }

  // 1. Deploy DecimalQuote (no constructor args)
  console.log("\n--- Step 1: Deploy DecimalQuote ---");
  const dqBytecode = readBytecodeFile("DecimalQuote.bin");
  const dqFactory = new ethers.ContractFactory(DECIMAL_QUOTE_ABI, dqBytecode, signer);
  const dq = await dqFactory.deploy();
  console.log(`DecimalQuote deploy TX: ${dq.deploymentTransaction()?.hash}`);
  await dq.waitForDeployment();
  const dqAddress = await dq.getAddress();
  console.log(`DecimalQuote deployed at: ${dqAddress}`);

  // 2. Deploy SwapPool
  console.log("\n--- Step 2: Deploy SwapPool ---");
  const spBytecode = readBytecodeFile("SwapPool.bin");
  const spFactory = new ethers.ContractFactory(SWAP_POOL_ABI, spBytecode, signer);
  // Constructor: name, symbol, decimals, tokenRegistry, tokenLimiter
  const pool = await spFactory.deploy(
    "BKC Commitment Pool",
    "BCCP",
    6, // matches VCV decimals
    ethers.ZeroAddress, // accept all tokens
    ethers.ZeroAddress, // no limits
  );
  console.log(`SwapPool deploy TX: ${pool.deploymentTransaction()?.hash}`);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`SwapPool deployed at: ${poolAddress}`);

  // 3. Post-deploy setup (owner-only)
  console.log("\n--- Step 3: Configure Pool ---");

  console.log("Setting quoter...");
  const setQuoterTx = await (pool as any).setQuoter(dqAddress);
  await setQuoterTx.wait();
  console.log(`Quoter set to: ${dqAddress}`);

  console.log("Setting fee to 0...");
  const setFeeTx = await (pool as any).setFee(0);
  await setFeeTx.wait();
  console.log("Fee: 0");

  console.log("Setting fee address...");
  const setFeeAddrTx = await (pool as any).setFeeAddress(address);
  await setFeeAddrTx.wait();
  console.log(`Fee address: ${address}`);

  // 4. Deposit VCV liquidity
  if (VCV_TOKEN_ADDRESS) {
    console.log("\n--- Step 4: Deposit VCV Liquidity ---");
    const vcvToken = new ethers.Contract(VCV_TOKEN_ADDRESS, ERC20_APPROVE_ABI, signer);
    const vcvBalance = await vcvToken.balanceOf(address);
    const vcvDecimals = await vcvToken.decimals();
    console.log(`VCV balance: ${ethers.formatUnits(vcvBalance, vcvDecimals)} VCV`);

    if (vcvBalance > 0n) {
      // Deposit half of VCV balance into pool
      const depositAmount = vcvBalance / 2n;
      console.log(`Depositing ${ethers.formatUnits(depositAmount, vcvDecimals)} VCV...`);

      // Approve pool to spend VCV
      const approveTx = await vcvToken.approve(poolAddress, depositAmount);
      await approveTx.wait();
      console.log("VCV approved for pool");

      // Deposit
      const depositTx = await (pool as any).deposit(VCV_TOKEN_ADDRESS, depositAmount);
      await depositTx.wait();
      console.log(`VCV deposited: ${ethers.formatUnits(depositAmount, vcvDecimals)} VCV`);
    } else {
      console.log("No VCV balance to deposit. Deposit manually later.");
    }
  } else {
    console.log("\nSkipping VCV deposit — VCV_TOKEN_ADDRESS not set");
  }

  // 5. Verify
  console.log("\n=== Deployment Summary ===");
  console.log(`SwapPool: ${poolAddress}`);
  console.log(`DecimalQuote: ${dqAddress}`);
  console.log(`Quoter: ${await (pool as any).quoter()}`);
  console.log(`Fee: ${await (pool as any).feePpm()} ppm`);
  console.log(`Owner: ${await (pool as any).owner()}`);

  // Try getQuote via staticCall
  if (VCV_TOKEN_ADDRESS) {
    try {
      const quoteAmount = ethers.parseUnits("100", 6); // 100 VCV
      const quote = await (pool as any).getQuote.staticCall(
        CUSD_ADDRESS,
        VCV_TOKEN_ADDRESS,
        quoteAmount,
      );
      console.log(
        `\nQuote: 100 VCV → ${ethers.formatUnits(quote, 18)} cUSD (DecimalQuote 1:1 with decimal adjustment)`,
      );
    } catch (e: any) {
      console.log(`\ngetQuote staticCall: ${e.message?.slice(0, 100)}`);
    }
  }

  console.log(`\nAdd to .env:`);
  console.log(`SWAP_POOL_ADDRESS=${poolAddress}`);
  console.log(`DECIMAL_QUOTE_ADDRESS=${dqAddress}`);
}

// --- Status ---

async function status(): Promise<void> {
  const poolAddress = process.env.SWAP_POOL_ADDRESS;
  if (!poolAddress) {
    console.error("Error: SWAP_POOL_ADDRESS not set in .env");
    process.exit(1);
  }

  console.log("\n=== BKC SwapPool Status ===\n");

  const signer = getSigner();
  const pool = new ethers.Contract(poolAddress, SWAP_POOL_ABI, signer);

  const name = await pool.name();
  const symbol = await pool.symbol();
  const decimals = await pool.decimals();
  const owner = await pool.owner();
  const quoter = await pool.quoter();
  const feePpm = await pool.feePpm();
  const feeAddr = await pool.feeAddress();
  const totalSupply = await pool.totalSupply();

  console.log(`Pool: ${poolAddress}`);
  console.log(`Name: ${name}`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Decimals: ${decimals}`);
  console.log(`Owner: ${owner}`);
  console.log(`Quoter: ${quoter}`);
  console.log(`Fee: ${feePpm} ppm`);
  console.log(`Fee Address: ${feeAddr}`);
  console.log(`Total Supply: ${ethers.formatUnits(totalSupply, Number(decimals))}`);

  // Check VCV balance in pool
  if (VCV_TOKEN_ADDRESS) {
    const vcvToken = new ethers.Contract(VCV_TOKEN_ADDRESS, ERC20_APPROVE_ABI, signer);
    const poolVcv = await vcvToken.balanceOf(poolAddress);
    const vcvDec = await vcvToken.decimals();
    console.log(`\nVCV in pool: ${ethers.formatUnits(poolVcv, vcvDec)} VCV`);

    // Try getQuote
    if (poolVcv > 0n) {
      try {
        const quoteAmount = ethers.parseUnits("100", Number(vcvDec));
        const quote = await pool.getQuote.staticCall(CUSD_ADDRESS, VCV_TOKEN_ADDRESS, quoteAmount);
        console.log(`Quote: 100 VCV → ${ethers.formatUnits(quote, 18)} cUSD`);
      } catch (e: any) {
        console.log(`getQuote: ${e.message?.slice(0, 100)}`);
      }
    }
  }

  // Check cUSD balance in pool
  const cusdToken = new ethers.Contract(CUSD_ADDRESS, ERC20_APPROVE_ABI, signer);
  const poolCusd = await cusdToken.balanceOf(poolAddress);
  console.log(`cUSD in pool: ${ethers.formatUnits(poolCusd, 18)} cUSD`);
}

// --- Deposit ---

async function depositVcv(amount: string): Promise<void> {
  const poolAddress = process.env.SWAP_POOL_ADDRESS;
  if (!poolAddress || !VCV_TOKEN_ADDRESS) {
    console.error("Error: SWAP_POOL_ADDRESS and VCV_TOKEN_ADDRESS must be set in .env");
    process.exit(1);
  }

  const signer = getSigner();
  const vcvToken = new ethers.Contract(VCV_TOKEN_ADDRESS, ERC20_APPROVE_ABI, signer);
  const pool = new ethers.Contract(poolAddress, SWAP_POOL_ABI, signer);
  const vcvDecimals = await vcvToken.decimals();

  const depositAmount = ethers.parseUnits(amount, vcvDecimals);
  console.log(`\nDepositing ${amount} VCV into pool ${poolAddress}...`);

  const approveTx = await vcvToken.approve(poolAddress, depositAmount);
  await approveTx.wait();
  console.log("Approved");

  const depositTx = await pool.deposit(VCV_TOKEN_ADDRESS, depositAmount);
  const receipt = await depositTx.wait();
  console.log(`Deposited in block ${receipt.blockNumber}`);
  console.log(`TX: ${depositTx.hash}`);
}

// --- Deposit cUSD ---

async function depositCusd(amount: string): Promise<void> {
  const poolAddress = process.env.SWAP_POOL_ADDRESS;
  if (!poolAddress) {
    console.error("Error: SWAP_POOL_ADDRESS must be set in .env");
    process.exit(1);
  }

  const signer = getSigner();
  const cusdToken = new ethers.Contract(CUSD_ADDRESS, ERC20_APPROVE_ABI, signer);
  const pool = new ethers.Contract(poolAddress, SWAP_POOL_ABI, signer);

  const depositAmount = ethers.parseUnits(amount, 18); // cUSD has 18 decimals
  console.log(`\nDepositing ${amount} cUSD into pool ${poolAddress}...`);

  const approveTx = await cusdToken.approve(poolAddress, depositAmount);
  await approveTx.wait();
  console.log("Approved");

  const depositTx = await pool.deposit(CUSD_ADDRESS, depositAmount);
  const receipt = await depositTx.wait();
  console.log(`Deposited in block ${receipt.blockNumber}`);
  console.log(`TX: ${depositTx.hash}`);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    await status();
    return;
  }

  if (args.includes("--deposit-cusd")) {
    const amountIdx = args.indexOf("--deposit-cusd") + 1;
    const amount = args[amountIdx] || "5";
    await depositCusd(amount);
    return;
  }

  if (args.includes("--deposit")) {
    const amountIdx = args.indexOf("--deposit") + 1;
    const amount = args[amountIdx] || "1000";
    await depositVcv(amount);
    return;
  }

  await deploy();
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
