import "dotenv/config";
import { ethers } from "ethers";

// Minimal GiftableToken ABI for minting
const GIFTABLE_ABI = [
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
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalMinted",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// --- Config ---
const CELO_RPC = process.env.CELO_RPC_URL || "https://forno.celo.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TOKEN_ADDRESS = process.env.VCV_TOKEN_ADDRESS;
const KOI_BASE = process.env.KOI_API_BASE_URL || "http://localhost:8351";

// Default mint amount when commitment has no estimated_value_usd
const DEFAULT_MINT_AMOUNT = 100;

function getSigner(): ethers.Wallet {
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const provider = new ethers.JsonRpcProvider(CELO_RPC);
  return new ethers.Wallet(key, provider);
}

function getToken(signer: ethers.Wallet): ethers.Contract {
  if (!TOKEN_ADDRESS) {
    console.error("Error: VCV_TOKEN_ADDRESS not set in .env");
    process.exit(1);
  }
  return new ethers.Contract(TOKEN_ADDRESS, GIFTABLE_ABI, signer);
}

// --- Fetch commitment from KOI API ---

interface Commitment {
  commitment_rid: string;
  title: string;
  state: string;
  offer_type: string;
  metadata: Record<string, any>;
}

async function fetchCommitment(rid: string): Promise<Commitment> {
  const url = `${KOI_BASE}/commitments/${encodeURIComponent(rid)}`;
  console.log(`Fetching commitment from: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to fetch commitment (${resp.status}): ${body}`);
  }
  return resp.json();
}

async function patchCommitmentMetadata(
  rid: string,
  metadata: Record<string, any>,
): Promise<void> {
  const url = `${KOI_BASE}/commitments/${encodeURIComponent(rid)}/metadata`;
  console.log(`Patching commitment metadata: ${url}`);
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to patch metadata (${resp.status}): ${body}`);
  }
}

// --- Mint ---

async function mintForCommitment(commitmentRid: string): Promise<void> {
  console.log("\n=== Minting VCV Tokens for Commitment ===\n");
  console.log(`Commitment RID: ${commitmentRid}`);

  // 1. Fetch commitment
  const commitment = await fetchCommitment(commitmentRid);
  console.log(`Title: ${commitment.title}`);
  console.log(`State: ${commitment.state}`);
  console.log(`Offer type: ${commitment.offer_type}`);

  // 2. Validate state
  if (commitment.state !== "VERIFIED" && commitment.state !== "ACTIVE") {
    console.error(
      `Error: Commitment is in ${commitment.state} state. Must be VERIFIED or ACTIVE to mint.`,
    );
    process.exit(1);
  }

  // Check if already minted
  if (commitment.metadata?.mint_tx_hash) {
    console.log(`\nAlready minted! TX: ${commitment.metadata.mint_tx_hash}`);
    console.log(`Amount: ${commitment.metadata.minted_amount} VCV`);
    console.log(`Token: ${commitment.metadata.token_address}`);
    return;
  }

  // 3. Determine mint amount
  const valueUsd =
    commitment.metadata?.estimated_value_usd ?? DEFAULT_MINT_AMOUNT;
  // 1 VCV per USD of estimated value (with 6 decimals)
  const decimals = 6;
  const mintAmount = ethers.parseUnits(String(valueUsd), decimals);
  console.log(`\nEstimated value: $${valueUsd}`);
  console.log(`Mint amount: ${ethers.formatUnits(mintAmount, decimals)} VCV`);

  // 4. Connect to token
  const signer = getSigner();
  const address = await signer.getAddress();
  const token = getToken(signer);

  const balance = await signer.provider!.getBalance(address);
  console.log(`\nAgent wallet: ${address}`);
  console.log(`CELO balance: ${ethers.formatEther(balance)} CELO`);

  // 5. Mint
  console.log("\nMinting...");
  const tx = await token.mintTo(address, mintAmount);
  console.log(`TX: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  // 6. Record in commitment metadata
  const mintMetadata = {
    mint_tx_hash: tx.hash,
    mint_block: receipt.blockNumber,
    token_address: TOKEN_ADDRESS,
    minted_amount: ethers.formatUnits(mintAmount, decimals),
    minted_at: new Date().toISOString(),
    chain_id: 42220, // Celo mainnet
  };

  try {
    await patchCommitmentMetadata(commitmentRid, mintMetadata);
    console.log("\nMetadata recorded in commitment");
  } catch (e: any) {
    console.warn(`Warning: Failed to record metadata: ${e.message}`);
    console.log("Mint succeeded but metadata not recorded. Manual update:");
    console.log(JSON.stringify(mintMetadata, null, 2));
  }

  // 7. Verify
  const newBalance = await token.balanceOf(address);
  const totalSupply = await token.totalSupply();
  console.log(`\n=== Mint Summary ===`);
  console.log(`Commitment: ${commitmentRid}`);
  console.log(`Amount: ${ethers.formatUnits(mintAmount, decimals)} VCV`);
  console.log(`TX: ${tx.hash}`);
  console.log(`Agent VCV balance: ${ethers.formatUnits(newBalance, decimals)} VCV`);
  console.log(`Total supply: ${ethers.formatUnits(totalSupply, decimals)} VCV`);
}

async function checkBalance(): Promise<void> {
  const signer = getSigner();
  const address = await signer.getAddress();

  const balance = await signer.provider!.getBalance(address);
  console.log(`Address: ${address}`);
  console.log(`CELO Balance: ${ethers.formatEther(balance)} CELO`);

  if (TOKEN_ADDRESS) {
    const token = getToken(signer);
    const tokenBalance = await token.balanceOf(address);
    const decimals = await token.decimals();
    const totalSupply = await token.totalSupply();
    console.log(`VCV Balance: ${ethers.formatUnits(tokenBalance, decimals)} VCV`);
    console.log(`VCV Total Supply: ${ethers.formatUnits(totalSupply, decimals)} VCV`);
    console.log(`Token Address: ${TOKEN_ADDRESS}`);
  } else {
    console.log("VCV_TOKEN_ADDRESS not set — token not deployed yet");
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--check-balance")) {
    await checkBalance();
    return;
  }

  const commitmentRid = args[0];
  if (!commitmentRid) {
    console.log("Usage:");
    console.log("  npx tsx mint-commitment-token.ts <commitment-rid>    Mint VCV for a VERIFIED commitment");
    console.log("  npx tsx mint-commitment-token.ts --check-balance     Check wallet balances");
    console.log("\nExample:");
    console.log("  npx tsx mint-commitment-token.ts orn:koi-net.commitment:afa7a4b8211a926edac3d1adb2497f26");
    process.exit(0);
  }

  await mintForCommitment(commitmentRid);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
