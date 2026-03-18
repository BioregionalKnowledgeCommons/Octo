import "dotenv/config";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

// --- ABI ---

const SETTLER_ABI = [
  {
    inputs: [{ internalType: "address", name: "_token", type: "address" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [
      { internalType: "address", name: "_node", type: "address" },
      { internalType: "uint256", name: "_threshold", type: "uint256" },
    ],
    name: "registerNode",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "fromNode", type: "address" },
      { internalType: "uint256[]", name: "targetIndices", type: "uint256[]" },
      { internalType: "uint96[]", name: "weights", type: "uint96[]" },
    ],
    name: "setAllocations",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "getNodeCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getNetworkState",
    outputs: [
      { internalType: "address[]", name: "", type: "address[]" },
      { internalType: "uint256[]", name: "", type: "uint256[]" },
      { internalType: "uint256[]", name: "", type: "uint256[]" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token",
    outputs: [{ internalType: "address", name: "", type: "address" }],
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
    name: "lastSettleTimestamp",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "lastSettleIterations",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "lastSettleConverged",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "lastSettleTotalRedistributed",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "settle",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const TOKEN_ABI = [
  {
    inputs: [
      { internalType: "address", name: "_to", type: "address" },
      { internalType: "uint256", name: "_value", type: "uint256" },
    ],
    name: "mintTo",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
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

// --- Config ---

const CELO_RPC = process.env.CELO_RPC_URL || "https://forno.celo.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VCV_ADDRESS = process.env.VCV_TOKEN_ADDRESS;
const DECIMALS = 6; // VCV decimals

const WAD = BigInt("1000000000000000000"); // 1e18

// Participant configuration
interface ParticipantConfig {
  label: string;
  envKey: string;
  mintVcv: number;    // VCV to mint (human units)
  threshold: number;  // VCV threshold (human units)
}

const PARTICIPANTS: ParticipantConfig[] = [
  { label: "Darren (Human)",     envKey: "PARTICIPANT_DARREN_KEY", mintVcv: 4000, threshold: 1000 },
  { label: "Victoria Hub (Org)", envKey: "PARTICIPANT_VHUB_KEY",   mintVcv: 500,  threshold: 2000 },
  { label: "Kinship Earth (Org)", envKey: "PARTICIPANT_KEARTH_KEY", mintVcv: 300,  threshold: 1800 },
];

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(CELO_RPC);
}

function getAgentSigner(): ethers.Wallet {
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  return new ethers.Wallet(key, getProvider());
}

function getParticipantWallet(envKey: string): ethers.Wallet | null {
  const pk = process.env[envKey];
  if (!pk) return null;
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  return new ethers.Wallet(key, getProvider());
}

function readBytecodeFile(filename: string): string {
  const localPath = path.join(__dirname, "abi", filename);
  const foundryPath = path.join(
    process.env.HOME || "",
    "projects/tbff-protocol/contracts/out/TBFFSettler.sol/TBFFSettler.json",
  );

  if (fs.existsSync(localPath)) {
    const hex = fs.readFileSync(localPath, "utf-8").trim();
    return hex.startsWith("0x") ? hex : `0x${hex}`;
  }

  if (fs.existsSync(foundryPath)) {
    const artifact = JSON.parse(fs.readFileSync(foundryPath, "utf-8"));
    const bc = artifact.bytecode?.object || artifact.bytecode;
    return bc.startsWith("0x") ? bc : `0x${bc}`;
  }

  throw new Error(
    `Bytecode not found. Place TBFFSettler.bin in ./abi/ or ensure tbff-protocol is at ~/projects/`,
  );
}

// Address → label map for display
function buildLabelMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of PARTICIPANTS) {
    const w = getParticipantWallet(p.envKey);
    if (w) map[w.address] = p.label;
  }
  return map;
}

// --- Check / generate participant keys ---

function ensureParticipantKeys(): boolean {
  const missing: string[] = [];
  for (const p of PARTICIPANTS) {
    if (!process.env[p.envKey]) missing.push(p.envKey);
  }

  if (missing.length === 0) return true;

  console.log("\n=== Generating Participant Wallets ===\n");
  console.log("The following keys are missing from .env:\n");
  for (const key of missing) {
    const wallet = ethers.Wallet.createRandom();
    console.log(`${key}=${wallet.privateKey.slice(2)}`);
    console.log(`  Address: ${wallet.address}\n`);
  }
  console.log("Add these lines to your .env file, then re-run.");
  return false;
}

// --- Deploy ---

async function deploy(): Promise<void> {
  if (!VCV_ADDRESS) {
    console.error("Error: VCV_TOKEN_ADDRESS not set in .env");
    process.exit(1);
  }

  console.log("\n=== Deploying Multi-Participant TBFFSettler ===\n");

  const signer = getAgentSigner();
  const address = await signer.getAddress();
  console.log(`Deployer (agent): ${address}`);

  const balance = await signer.provider!.getBalance(address);
  console.log(`CELO balance: ${ethers.formatEther(balance)} CELO`);
  console.log(`VCV token: ${VCV_ADDRESS}`);

  // Read bytecode
  const bytecode = readBytecodeFile("TBFFSettler.bin");
  console.log(`Bytecode: ${bytecode.length} chars`);

  // Deploy
  console.log("\nDeploying TBFFSettler...");
  const factory = new ethers.ContractFactory(SETTLER_ABI, bytecode, signer);
  const settler = await factory.deploy(VCV_ADDRESS);
  const deployTx = settler.deploymentTransaction();
  console.log(`Deploy TX: ${deployTx?.hash}`);
  console.log("Waiting for confirmation...");
  await settler.waitForDeployment();
  const settlerAddress = await settler.getAddress();
  console.log(`Settler deployed at: ${settlerAddress}`);

  // Register 3 nodes
  console.log("\nRegistering participants...");
  for (let i = 0; i < PARTICIPANTS.length; i++) {
    const p = PARTICIPANTS[i];
    const wallet = getParticipantWallet(p.envKey);
    if (!wallet) {
      console.error(`  Missing key: ${p.envKey}`);
      continue;
    }
    const thresholdRaw = ethers.parseUnits(String(p.threshold), DECIMALS);
    console.log(`  [${i}] ${p.label}: ${wallet.address}  threshold=${p.threshold} VCV`);
    const tx = await (settler as any).registerNode(wallet.address, thresholdRaw);
    await tx.wait();
    console.log(`      Registered`);
  }

  // Set allocations: Darren (index 0) → Victoria Hub (index 1) 50% + Kinship Earth (index 2) 50%
  console.log("\nSetting allocations...");
  const darrenWallet = getParticipantWallet(PARTICIPANTS[0].envKey)!;
  const halfWad = WAD / 2n;
  const tx = await (settler as any).setAllocations(
    darrenWallet.address,
    [1, 2],              // target indices
    [halfWad, halfWad],  // 50%/50% weights, sums to WAD
  );
  await tx.wait();
  console.log(`  Darren → [1] Victoria Hub (50%), [2] Kinship Earth (50%)`);

  console.log(`\n=== Multi-Participant Settler Deployed ===`);
  console.log(`Address: ${settlerAddress}`);
  console.log(`Participants: ${PARTICIPANTS.length}`);
  console.log(`\nAdd to .env:`);
  console.log(`MULTI_SETTLER_ADDRESS=${settlerAddress}`);
}

// --- Fund ---

async function fund(): Promise<void> {
  if (!VCV_ADDRESS) {
    console.error("Error: VCV_TOKEN_ADDRESS not set in .env");
    process.exit(1);
  }

  console.log("\n=== Funding Participant Wallets ===\n");

  const signer = getAgentSigner();
  const token = new ethers.Contract(VCV_ADDRESS, TOKEN_ABI, signer);

  for (const p of PARTICIPANTS) {
    const wallet = getParticipantWallet(p.envKey);
    if (!wallet) {
      console.error(`  Missing key: ${p.envKey}`);
      continue;
    }
    const addr = wallet.address;
    console.log(`\n${p.label} (${addr}):`);

    // Send 0.01 CELO for gas
    const celoBalance = await signer.provider!.getBalance(addr);
    if (celoBalance < ethers.parseEther("0.005")) {
      console.log("  Sending 0.01 CELO for gas...");
      const celoTx = await signer.sendTransaction({
        to: addr,
        value: ethers.parseEther("0.01"),
      });
      await celoTx.wait();
      console.log(`  CELO sent: ${celoTx.hash}`);
    } else {
      console.log(`  CELO balance OK: ${ethers.formatEther(celoBalance)} CELO`);
    }

    // Mint VCV
    const mintAmount = ethers.parseUnits(String(p.mintVcv), DECIMALS);
    console.log(`  Minting ${p.mintVcv} VCV...`);
    const mintTx = await token.mintTo(addr, mintAmount);
    await mintTx.wait();
    console.log(`  Minted: ${mintTx.hash}`);

    // Verify balance
    const vcvBal = await token.balanceOf(addr);
    console.log(`  VCV balance: ${ethers.formatUnits(vcvBal, DECIMALS)} VCV`);
  }

  console.log("\n=== Funding Complete ===");
}

// --- Approve ---

async function approve(): Promise<void> {
  const settlerAddress = process.env.MULTI_SETTLER_ADDRESS;
  if (!settlerAddress || !VCV_ADDRESS) {
    console.error("Error: MULTI_SETTLER_ADDRESS and VCV_TOKEN_ADDRESS must be set in .env");
    process.exit(1);
  }

  console.log("\n=== Approving Settler from All Wallets ===\n");
  console.log(`Settler: ${settlerAddress}`);

  for (const p of PARTICIPANTS) {
    const wallet = getParticipantWallet(p.envKey);
    if (!wallet) {
      console.error(`  Missing key: ${p.envKey}`);
      continue;
    }
    const token = new ethers.Contract(VCV_ADDRESS, TOKEN_ABI, wallet);
    console.log(`  ${p.label}: approving...`);
    const tx = await token.approve(settlerAddress, ethers.MaxUint256);
    await tx.wait();
    console.log(`  Approved: ${tx.hash}`);
  }

  console.log("\n=== All Approvals Complete ===");
}

// --- Settle ---

async function settle(): Promise<void> {
  const settlerAddress = process.env.MULTI_SETTLER_ADDRESS;
  if (!settlerAddress) {
    console.error("Error: MULTI_SETTLER_ADDRESS not set in .env");
    process.exit(1);
  }

  const signer = getAgentSigner();
  const settler = new ethers.Contract(settlerAddress, SETTLER_ABI, signer);

  console.log("\n=== Executing TBFF Settlement ===\n");
  console.log("Calling settle()...");
  const tx = await settler.settle();
  console.log(`TX: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  const iterations = await settler.lastSettleIterations();
  const converged = await settler.lastSettleConverged();
  const totalRedist = await settler.lastSettleTotalRedistributed();

  console.log(`\nIterations: ${iterations}`);
  console.log(`Converged: ${converged}`);
  console.log(`Total redistributed: ${ethers.formatUnits(totalRedist, DECIMALS)} VCV`);

  console.log(`\n--- SETTLE_TX ---`);
  console.log(tx.hash);
}

// --- Status ---

async function status(): Promise<void> {
  const settlerAddress = process.env.MULTI_SETTLER_ADDRESS;
  if (!settlerAddress) {
    console.error("Error: MULTI_SETTLER_ADDRESS not set in .env");
    process.exit(1);
  }

  console.log("\n=== Multi-Participant Settler Status ===\n");

  const signer = getAgentSigner();
  const settler = new ethers.Contract(settlerAddress, SETTLER_ABI, signer);
  const labels = buildLabelMap();

  const nodeCount = await settler.getNodeCount();
  const tokenAddr = await settler.token();
  const owner = await settler.owner();
  const lastTs = await settler.lastSettleTimestamp();
  const lastIter = await settler.lastSettleIterations();
  const converged = await settler.lastSettleConverged();
  const redistrib = await settler.lastSettleTotalRedistributed();

  console.log(`Settler: ${settlerAddress}`);
  console.log(`Token: ${tokenAddr}`);
  console.log(`Owner: ${owner}`);
  console.log(`Nodes: ${nodeCount}`);
  console.log(`Last settle: ${lastTs > 0n ? new Date(Number(lastTs) * 1000).toISOString() : "never"}`);
  console.log(`Last iterations: ${lastIter}`);
  console.log(`Last converged: ${converged}`);
  console.log(`Last redistributed: ${ethers.formatUnits(redistrib, DECIMALS)} VCV`);

  const [nodes, balances, thresholds] = await settler.getNetworkState();
  console.log("\n--- Network State ---");
  for (let i = 0; i < nodes.length; i++) {
    const addr = nodes[i] as string;
    const label = labels[addr] || `Node ${i}`;
    const bal = ethers.formatUnits(balances[i], DECIMALS);
    const thresh = ethers.formatUnits(thresholds[i], DECIMALS);
    console.log(`  [${i}] ${label} (${addr})`);
    console.log(`       balance=${bal} VCV  threshold=${thresh} VCV`);
  }
}

// --- Status JSON ---

async function statusJson(): Promise<void> {
  const settlerAddress = process.env.MULTI_SETTLER_ADDRESS;
  if (!settlerAddress) {
    console.error("Error: MULTI_SETTLER_ADDRESS not set in .env");
    process.exit(1);
  }

  const signer = getAgentSigner();
  const settler = new ethers.Contract(settlerAddress, SETTLER_ABI, signer);
  const labels = buildLabelMap();

  const [nodes, balances, thresholds] = await settler.getNetworkState();
  const nodeArray = [];
  for (let i = 0; i < nodes.length; i++) {
    const addr = nodes[i] as string;
    nodeArray.push({
      address: addr,
      label: labels[addr] || `Node ${i}`,
      balance: parseFloat(ethers.formatUnits(balances[i], DECIMALS)),
      threshold: parseFloat(ethers.formatUnits(thresholds[i], DECIMALS)),
    });
  }

  console.log(JSON.stringify({ nodes: nodeArray }));
}

// --- All (convenience) ---

async function all(): Promise<void> {
  if (!ensureParticipantKeys()) process.exit(1);
  await deploy();
  // Read deployed address from output — user must update .env
  console.log("\n⚠ Update MULTI_SETTLER_ADDRESS in .env with the address above, then run --fund --approve --settle separately.");
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log("Usage:");
    console.log("  npx tsx deploy-multi-settler.ts                Show status (default)");
    console.log("  npx tsx deploy-multi-settler.ts --deploy       Deploy new settler contract");
    console.log("  npx tsx deploy-multi-settler.ts --fund         Mint VCV + send CELO to participant wallets");
    console.log("  npx tsx deploy-multi-settler.ts --approve      Approve settler from all wallets");
    console.log("  npx tsx deploy-multi-settler.ts --settle       Execute settlement");
    console.log("  npx tsx deploy-multi-settler.ts --status       Show network state");
    console.log("  npx tsx deploy-multi-settler.ts --status-json  Machine-readable state");
    console.log("  npx tsx deploy-multi-settler.ts --all          Deploy (then update .env manually)");

    if (process.env.MULTI_SETTLER_ADDRESS) {
      await status();
    } else {
      console.log("\nMULTI_SETTLER_ADDRESS not set. Run --deploy first.");
      // Check participant keys
      ensureParticipantKeys();
    }
    return;
  }

  if (args.includes("--all")) {
    await all();
    return;
  }

  if (args.includes("--deploy")) {
    if (!ensureParticipantKeys()) process.exit(1);
    await deploy();
    return;
  }

  if (args.includes("--fund")) {
    if (!ensureParticipantKeys()) process.exit(1);
    await fund();
    return;
  }

  if (args.includes("--approve")) {
    if (!ensureParticipantKeys()) process.exit(1);
    await approve();
    return;
  }

  if (args.includes("--settle")) {
    await settle();
    return;
  }

  if (args.includes("--status-json")) {
    await statusJson();
    return;
  }

  if (args.includes("--status")) {
    await status();
    return;
  }

  // Default: status
  await status();
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
