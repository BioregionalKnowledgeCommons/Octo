import "dotenv/config";
import { ethers } from "ethers";

// TBFFSettler ABI — extended with registerNode for deployment
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

// GiftableToken ABI for approve
const TOKEN_ABI = [
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
const TOKEN_ADDRESS = process.env.VCV_TOKEN_ADDRESS;
const KOI_BASE = process.env.KOI_API_BASE_URL || "http://localhost:8351";

// Demo participant thresholds (monthly fiat_only needs in USD, converted to VCV with 6 decimals)
// These are computed from commitment needs data
interface Participant {
  label: string;
  address: string;
  thresholdUsd: number;
}

function getSigner(): ethers.Wallet {
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const provider = new ethers.JsonRpcProvider(CELO_RPC);
  return new ethers.Wallet(key, provider);
}

// --- Fetch needs from KOI API to compute thresholds ---

async function computeThresholdFromNeeds(
  pledgerLabel: string,
): Promise<number> {
  try {
    const resp = await fetch(
      `${KOI_BASE}/commitments/?state=VERIFIED&limit=200`,
    );
    if (!resp.ok) return 0;
    const commitments: any[] = await resp.json();

    let totalFiatOnly = 0;
    for (const c of commitments) {
      const meta = c.metadata || {};
      if (meta.declaration_type === "need" && meta.fiat_only === true) {
        totalFiatOnly += meta.monthly_amount_usd || 0;
      }
    }
    return totalFiatOnly;
  } catch {
    return 0;
  }
}

// --- Deploy ---

async function deploySettler(): Promise<void> {
  if (!TOKEN_ADDRESS) {
    console.error("Error: VCV_TOKEN_ADDRESS not set in .env");
    process.exit(1);
  }

  console.log("\n=== Deploying Demo TBFFSettler ===\n");

  const signer = getSigner();
  const address = await signer.getAddress();
  console.log(`Deployer: ${address}`);

  const balance = await signer.provider!.getBalance(address);
  console.log(`CELO balance: ${ethers.formatEther(balance)} CELO`);
  console.log(`VCV token: ${TOKEN_ADDRESS}`);

  // Check current VCV balance
  const token = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer);
  const vcvBalance = await token.balanceOf(address);
  const decimals = await token.decimals();
  console.log(
    `VCV balance: ${ethers.formatUnits(vcvBalance, decimals)} VCV`,
  );

  // Compute thresholds from KOI needs data
  console.log("\nComputing thresholds from needs data...");
  const needsThreshold = await computeThresholdFromNeeds("all");
  console.log(`Total fiat-only needs: $${needsThreshold}/month`);

  // Define participants — both use the same wallet (agent as custodian)
  const participants: Participant[] = [
    {
      label: "Darren (Human Participant)",
      address: address,
      thresholdUsd: Math.max(needsThreshold, 200), // minimum $200 threshold
    },
  ];

  // Use Foundry-compiled bytecode if available, otherwise use pre-compiled
  const { existsSync, readFileSync } = await import("fs");
  const foundryArtifact =
    "../../tbff-protocol/contracts/out/TBFFSettler.sol/TBFFSettler.json";
  let bytecode: string;

  if (existsSync(foundryArtifact)) {
    const artifact = JSON.parse(readFileSync(foundryArtifact, "utf-8"));
    bytecode = artifact.bytecode?.object || artifact.bytecode;
    console.log("\nUsing Foundry-compiled bytecode");
  } else {
    // Try server artifact path
    console.log("\nNote: Foundry artifact not found locally.");
    console.log("To compile: cd ../../tbff-protocol/contracts && forge build");
    console.log("Using existing settler at:", process.env.TBFF_SETTLER_ADDRESS || "(none)");
    console.log("\nSkipping deployment — use --settle or --status with existing settler");
    return;
  }

  // Deploy
  console.log("\nDeploying TBFFSettler...");
  const factory = new ethers.ContractFactory(SETTLER_ABI, bytecode, signer);
  const settler = await factory.deploy(TOKEN_ADDRESS);
  const deployTx = settler.deploymentTransaction();
  console.log(`Deploy TX: ${deployTx?.hash}`);
  console.log("Waiting for confirmation...");
  await settler.waitForDeployment();
  const settlerAddress = await settler.getAddress();
  console.log(`Settler deployed at: ${settlerAddress}`);

  // Register participants
  console.log("\nRegistering participants...");
  for (const p of participants) {
    const thresholdWei = ethers.parseUnits(String(p.thresholdUsd), decimals);
    console.log(
      `  ${p.label}: threshold=${ethers.formatUnits(thresholdWei, decimals)} VCV`,
    );
    const tx = await (settler as any).registerNode(p.address, thresholdWei);
    await tx.wait();
    console.log(`  Registered`);
  }

  // Approve settler to spend VCV
  console.log("\nApproving settler to spend VCV...");
  const maxApproval = ethers.MaxUint256;
  const approveTx = await token.approve(settlerAddress, maxApproval);
  await approveTx.wait();
  console.log("Approved");

  // Summary
  console.log(`\n=== Demo Settler Deployed ===`);
  console.log(`Address: ${settlerAddress}`);
  console.log(`Token: ${TOKEN_ADDRESS}`);
  console.log(`Participants: ${participants.length}`);
  console.log(`\nUpdate .env:`);
  console.log(`TBFF_SETTLER_ADDRESS=${settlerAddress}`);
}

// --- Status ---

async function status(): Promise<void> {
  const settlerAddr = process.env.TBFF_SETTLER_ADDRESS;
  if (!settlerAddr) {
    console.error("Error: TBFF_SETTLER_ADDRESS not set");
    process.exit(1);
  }

  console.log("\n=== Demo Settler Status ===\n");

  const signer = getSigner();
  const settler = new ethers.Contract(settlerAddr, SETTLER_ABI, signer);

  const nodeCount = await settler.getNodeCount();
  const tokenAddr = await settler.token();
  const owner = await settler.owner();
  const lastTs = await settler.lastSettleTimestamp();
  const lastIter = await settler.lastSettleIterations();
  const converged = await settler.lastSettleConverged();
  const redistrib = await settler.lastSettleTotalRedistributed();

  console.log(`Settler: ${settlerAddr}`);
  console.log(`Token: ${tokenAddr}`);
  console.log(`Owner: ${owner}`);
  console.log(`Nodes: ${nodeCount}`);
  console.log(
    `Last settle: ${lastTs > 0n ? new Date(Number(lastTs) * 1000).toISOString() : "never"}`,
  );
  console.log(`Last iterations: ${lastIter}`);
  console.log(`Last converged: ${converged}`);
  console.log(
    `Last redistributed: ${ethers.formatUnits(redistrib, 6)} VCV`,
  );

  const [nodes, balances, thresholds] = await settler.getNetworkState();
  console.log("\n--- Network State ---");
  for (let i = 0; i < nodes.length; i++) {
    console.log(
      `  [${i}] ${nodes[i]}  balance=${ethers.formatUnits(balances[i], 6)} VCV  threshold=${ethers.formatUnits(thresholds[i], 6)} VCV`,
    );
  }
}

// --- Settle ---

async function settle(): Promise<void> {
  const settlerAddr = process.env.TBFF_SETTLER_ADDRESS;
  if (!settlerAddr) {
    console.error("Error: TBFF_SETTLER_ADDRESS not set");
    process.exit(1);
  }

  console.log("\n=== Executing TBFF Settlement ===\n");

  const signer = getSigner();
  const settler = new ethers.Contract(settlerAddr, SETTLER_ABI, signer);

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
  console.log(
    `Total redistributed: ${ethers.formatUnits(totalRedist, 6)} VCV`,
  );

  // Output settle TX for piping
  console.log(`\n--- SETTLE_TX ---`);
  console.log(tx.hash);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--deploy")) {
    await deploySettler();
    return;
  }

  if (args.includes("--settle")) {
    await settle();
    return;
  }

  if (args.includes("--status")) {
    await status();
    return;
  }

  // Default: show status
  console.log("Usage:");
  console.log("  npx tsx deploy-demo-settler.ts --deploy     Deploy new settler with demo thresholds");
  console.log("  npx tsx deploy-demo-settler.ts --status     Show settler status");
  console.log("  npx tsx deploy-demo-settler.ts --settle     Execute settlement");
  await status();
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
