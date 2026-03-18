import "dotenv/config";
import { ethers } from "ethers";

// Minimal TBFFSettler ABI for reading state
const SETTLER_ABI = [
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

// --- Config ---
const CELO_RPC = process.env.CELO_RPC_URL || "https://forno.celo.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SETTLER_ADDRESS = process.env.TBFF_SETTLER_ADDRESS;

function getSigner(): ethers.Wallet {
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const provider = new ethers.JsonRpcProvider(CELO_RPC);
  return new ethers.Wallet(key, provider);
}

function getSettler(signer: ethers.Wallet): ethers.Contract {
  if (!SETTLER_ADDRESS) {
    console.error("Error: TBFF_SETTLER_ADDRESS not set in .env");
    process.exit(1);
  }
  return new ethers.Contract(SETTLER_ADDRESS, SETTLER_ABI, signer);
}

async function status(): Promise<void> {
  console.log("\n=== TBFF Settler Status ===\n");

  const signer = getSigner();
  const settler = getSettler(signer);

  const nodeCount = await settler.getNodeCount();
  const token = await settler.token();
  const owner = await settler.owner();
  const lastSettleTs = await settler.lastSettleTimestamp();
  const lastIter = await settler.lastSettleIterations();
  const lastConverged = await settler.lastSettleConverged();
  const lastRedist = await settler.lastSettleTotalRedistributed();

  console.log(`Settler: ${SETTLER_ADDRESS}`);
  console.log(`Token: ${token}`);
  console.log(`Owner: ${owner}`);
  console.log(`Nodes: ${nodeCount}`);
  console.log(`Last settle: ${lastSettleTs > 0n ? new Date(Number(lastSettleTs) * 1000).toISOString() : "never"}`);
  console.log(`Last iterations: ${lastIter}`);
  console.log(`Last converged: ${lastConverged}`);
  console.log(`Last redistributed: ${ethers.formatUnits(lastRedist, 6)} VCV`);

  // Network state
  const [nodes, balances, thresholds] = await settler.getNetworkState();
  console.log("\n--- Network State ---");
  for (let i = 0; i < nodes.length; i++) {
    console.log(
      `  [${i}] ${nodes[i]}  balance=${ethers.formatUnits(balances[i], 6)} VCV  threshold=${ethers.formatUnits(thresholds[i], 6)} VCV`,
    );
  }
}

async function settle(): Promise<void> {
  console.log("\n=== Executing TBFF Settlement ===\n");

  const signer = getSigner();
  const settler = getSettler(signer);

  console.log("Calling settle()...");
  const tx = await settler.settle();
  console.log(`TX: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  // Read results
  const iterations = await settler.lastSettleIterations();
  const converged = await settler.lastSettleConverged();
  const totalRedist = await settler.lastSettleTotalRedistributed();

  console.log(`\nIterations: ${iterations}`);
  console.log(`Converged: ${converged}`);
  console.log(`Total redistributed: ${ethers.formatUnits(totalRedist, 6)} VCV`);
}

// Address → label map (matches deploy-demo-settler.ts participants)
const ADDRESS_LABELS: Record<string, string> = {
  "0x6f844901ACc577F10575e90B2264e186AEe1bA73": "Darren (Human Participant)",
};

async function statusJson(): Promise<void> {
  const signer = getSigner();
  const settler = getSettler(signer);

  const [nodes, balances, thresholds] = await settler.getNetworkState();
  const agentAddress = await signer.getAddress();

  const nodeArray = [];
  for (let i = 0; i < nodes.length; i++) {
    const addr = nodes[i] as string;
    let label = ADDRESS_LABELS[addr] || `Node ${i}`;
    if (addr.toLowerCase() === agentAddress.toLowerCase() && !ADDRESS_LABELS[addr]) {
      label = "Octo Agent";
    }
    nodeArray.push({
      address: addr,
      label,
      balance: parseFloat(ethers.formatUnits(balances[i], 6)),
      threshold: parseFloat(ethers.formatUnits(thresholds[i], 6)),
    });
  }

  const output = JSON.stringify({ nodes: nodeArray });
  console.log(output);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--settle")) {
    await settle();
    return;
  }

  if (args.includes("--status-json")) {
    await statusJson();
    return;
  }

  // Default: show status
  await status();
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
