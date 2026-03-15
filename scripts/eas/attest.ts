import "dotenv/config";
import { EAS, SchemaEncoder, SchemaRegistry } from "@ethereum-attestation-service/eas-sdk";
import { ethers } from "ethers";

// --- Celo EAS contract addresses (verified from docs.attest.org) ---
const EAS_CONTRACT = "0x72E1d8ccf5299fb36fEfD8CC4394B8ef7e98Af92";
const SCHEMA_REGISTRY = "0x5ece93bE4BDCF293Ed61FA78698B594F2135AF34";

// BKC attestation schema
const SCHEMA_STRING =
  "string commitmentRid, bytes32 contentHash, string proofPackUri, string regenTxHash, string bioregion, uint64 verifiedAt";

// --- Config ---
const CELO_RPC = process.env.CELO_RPC_URL || "https://forno.celo.org";
const KOI_BASE = process.env.KOI_API_BASE_URL || "http://45.132.245.30:8351";
// Public URL for proof pack URIs stored on-chain (may differ from KOI_BASE when using SSH tunnel)
const KOI_PUBLIC = process.env.KOI_PUBLIC_URL || KOI_BASE;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SCHEMA_UID = process.env.EAS_SCHEMA_UID;

// --- Helpers ---

function getSigner(): ethers.Wallet {
  if (!PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const provider = new ethers.JsonRpcProvider(CELO_RPC);
  return new ethers.Wallet(key, provider);
}

async function fetchProofPack(claimRid: string): Promise<any> {
  const url = `${KOI_BASE}/claims/${encodeURIComponent(claimRid)}/proof-pack`;
  console.log(`Fetching proof pack from: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to fetch proof pack (${resp.status}): ${body}`);
  }
  return resp.json();
}

function extractBioregion(proofPack: any): string {
  // Try to extract bioregion from about_uri or claim metadata
  const aboutUri: string = proofPack.claim?.about_uri || "";
  if (aboutUri.includes("salish-sea")) return "Salish Sea";
  if (aboutUri.includes("front-range")) return "Front Range";
  if (aboutUri.includes("greater-victoria")) return "Greater Victoria";
  if (aboutUri.includes("cowichan")) return "Cowichan Valley";
  if (aboutUri.includes("cascadia")) return "Cascadia";
  // Fallback: check statement text
  const statement: string = proofPack.claim?.statement || "";
  if (statement.toLowerCase().includes("salish sea")) return "Salish Sea";
  if (statement.toLowerCase().includes("front range")) return "Front Range";
  if (statement.toLowerCase().includes("victoria")) return "Greater Victoria";
  return "Unknown";
}

function extractVerifiedAt(proofPack: any): number {
  // Find the state transition to verified or ledger_anchored
  const history: any[] = proofPack.history || [];
  const anchorEntry = history.find((h: any) => h.to_state === "ledger_anchored");
  const verifiedEntry = history.find((h: any) => h.to_state === "verified");
  const entry = anchorEntry || verifiedEntry;
  if (entry?.created_at) {
    return Math.floor(new Date(entry.created_at).getTime() / 1000);
  }
  // Fallback to anchor timestamp
  if (proofPack.anchor?.ledger_timestamp) {
    return Math.floor(new Date(proofPack.anchor.ledger_timestamp).getTime() / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

// --- Schema Registration ---

async function registerSchema(): Promise<string> {
  console.log("\n=== Registering BKC Schema on Celo EAS ===\n");

  const signer = getSigner();
  const address = await signer.getAddress();
  console.log(`Wallet: ${address}`);

  const balance = await signer.provider!.getBalance(address);
  console.log(`Balance: ${ethers.formatEther(balance)} CELO`);

  if (balance === 0n) {
    console.error("Error: Wallet has no CELO for gas");
    process.exit(1);
  }

  const registry = new SchemaRegistry(SCHEMA_REGISTRY);
  registry.connect(signer);

  console.log(`\nSchema: ${SCHEMA_STRING}`);
  console.log("Revocable: true");
  console.log("Registering...");

  const tx = await registry.register({
    schema: SCHEMA_STRING,
    revocable: true,
  });

  const schemaUid = await tx.wait();
  console.log(`\nSchema registered!`);
  console.log(`Schema UID: ${schemaUid}`);
  console.log(`View: https://celo.easscan.org/schema/view/${schemaUid}`);
  console.log(`\nAdd to .env:\nEAS_SCHEMA_UID=${schemaUid}`);

  return schemaUid;
}

// --- Attestation Creation ---

async function createAttestation(claimRid: string): Promise<void> {
  if (!SCHEMA_UID) {
    console.error("Error: EAS_SCHEMA_UID not set. Run with --register-schema first.");
    process.exit(1);
  }

  console.log("\n=== Creating BKC EAS Attestation on Celo ===\n");
  console.log(`Claim RID: ${claimRid}`);

  // 1. Fetch proof pack
  const proofPack = await fetchProofPack(claimRid);
  console.log(`Verification: ${proofPack.verification}`);

  if (proofPack.verification !== "ledger_anchored") {
    console.error(`Error: Claim is "${proofPack.verification}", not ledger_anchored`);
    process.exit(1);
  }

  // 2. Extract fields
  const contentHash = proofPack.anchor.content_hash;
  const regenTxHash = proofPack.anchor.tx_hash;
  const bioregion = extractBioregion(proofPack);
  const verifiedAt = extractVerifiedAt(proofPack);
  const proofPackUri = `${KOI_PUBLIC}/claims/${encodeURIComponent(claimRid)}/proof-pack`;

  console.log(`Content hash: ${contentHash}`);
  console.log(`Regen TX: ${regenTxHash}`);
  console.log(`Bioregion: ${bioregion}`);
  console.log(`Verified at: ${new Date(verifiedAt * 1000).toISOString()}`);
  console.log(`Proof pack URI: ${proofPackUri}`);

  // 3. Connect to EAS
  const signer = getSigner();
  const address = await signer.getAddress();
  console.log(`\nWallet: ${address}`);

  const balance = await signer.provider!.getBalance(address);
  console.log(`Balance: ${ethers.formatEther(balance)} CELO`);

  if (balance === 0n) {
    console.error("Error: Wallet has no CELO for gas");
    process.exit(1);
  }

  const eas = new EAS(EAS_CONTRACT);
  eas.connect(signer);

  // 4. Encode attestation data
  const schemaEncoder = new SchemaEncoder(SCHEMA_STRING);
  const contentHashBytes32 = "0x" + contentHash;

  const encodedData = schemaEncoder.encodeData([
    { name: "commitmentRid", value: claimRid, type: "string" },
    { name: "contentHash", value: contentHashBytes32, type: "bytes32" },
    { name: "proofPackUri", value: proofPackUri, type: "string" },
    { name: "regenTxHash", value: regenTxHash, type: "string" },
    { name: "bioregion", value: bioregion, type: "string" },
    { name: "verifiedAt", value: BigInt(verifiedAt), type: "uint64" },
  ]);

  // 5. Create attestation
  console.log("\nSubmitting attestation to Celo...");

  const tx = await eas.attest({
    schema: SCHEMA_UID,
    data: {
      recipient: ethers.ZeroAddress, // No specific recipient
      expirationTime: 0n, // No expiration
      revocable: true,
      refUID: ethers.ZeroHash, // No reference
      data: encodedData,
      value: 0n,
    },
  });

  const attestationUid = await tx.wait();
  console.log(`\nAttestation created!`);
  console.log(`Attestation UID: ${attestationUid}`);
  console.log(`View: https://celo.easscan.org/attestation/view/${attestationUid}`);

  // 6. Verify hash integrity
  console.log("\nVerifying on-chain hash integrity...");

  const attestation = await eas.getAttestation(attestationUid);
  if (!attestation?.data) {
    throw new Error("Failed to fetch attestation back from EAS");
  }

  const decoded = schemaEncoder.decodeData(attestation.data);
  const hashField = decoded.find((d) => d.name === "contentHash");
  if (!hashField) {
    throw new Error("contentHash field missing from decoded attestation data");
  }

  const storedHash = (hashField.value as any).value ?? hashField.value;
  const expectedHash = contentHashBytes32;
  const storedHex = typeof storedHash === "string" ? storedHash.toLowerCase() : storedHash;
  const expectedHex = expectedHash.toLowerCase();

  if (storedHex !== expectedHex) {
    console.error(`HASH MISMATCH: on-chain=${storedHex}, expected=${expectedHex}`);
    process.exit(1);
  }
  console.log("Hash verified: on-chain matches proof pack content_hash");

  // 7. Summary
  console.log("\n=== Dual-Chain Proof Summary ===\n");
  console.log(`Claim: ${claimRid}`);
  console.log(`Content Hash: ${contentHash}`);
  console.log(`Regen Ledger: TX ${regenTxHash}`);
  console.log(`Celo EAS:     UID ${attestationUid}`);
  console.log(`\nRegen explorer: (cosmos-based, no public explorer for regen-upgrade testnet)`);
  console.log(`Celo explorer:  https://celo.easscan.org/attestation/view/${attestationUid}`);
  console.log(`Proof pack:     ${proofPackUri}`);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--register-schema")) {
    await registerSchema();
    return;
  }

  if (args.includes("--check-balance")) {
    const signer = getSigner();
    const address = await signer.getAddress();
    const balance = await signer.provider!.getBalance(address);
    console.log(`Address: ${address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} CELO`);
    return;
  }

  // Default: create attestation
  const claimRid = args[0];
  if (!claimRid) {
    console.log("Usage:");
    console.log("  npx tsx attest.ts <claim-rid>          Create attestation for a claim");
    console.log("  npx tsx attest.ts --register-schema    Register BKC schema on Celo EAS");
    console.log("  npx tsx attest.ts --check-balance      Check wallet CELO balance");
    console.log("\nExample:");
    console.log("  npx tsx attest.ts orn:koi-net.claim:a42c60ce7e7f1848");
    process.exit(0);
  }

  await createAttestation(claimRid);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
