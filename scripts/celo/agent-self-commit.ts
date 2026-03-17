import "dotenv/config";

const KOI_BASE = process.env.KOI_API_BASE_URL || "http://localhost:8351";

interface CommitmentDef {
  title: string;
  description: string;
  declaration_type: "commitment" | "need";
  offer_type: string;
  need_category?: string;
  fiat_only?: boolean;
  monthly_amount_usd?: number;
  estimated_value_usd?: number;
  routing_tags: string[];
}

// --- Octo's commitments (what it offers) ---
const AGENT_COMMITMENTS: CommitmentDef[] = [
  {
    title: "Knowledge curation and entity resolution",
    description:
      "24/7 automated knowledge graph curation: entity extraction, resolution (5-tier dedup), relationship inference, and vault note generation for the Salish Sea bioregion",
    declaration_type: "commitment",
    offer_type: "service",
    estimated_value_usd: 500,
    routing_tags: [
      "knowledge-curation",
      "entity-resolution",
      "knowledge-graph",
      "automation",
    ],
  },
  {
    title: "Meeting transcript processing",
    description:
      "On-demand processing of meeting transcripts: entity extraction, commitment detection, task extraction, and entity linking with the bioregional knowledge commons",
    declaration_type: "commitment",
    offer_type: "service",
    estimated_value_usd: 200,
    routing_tags: [
      "transcript-processing",
      "meeting-notes",
      "commitment-extraction",
    ],
  },
  {
    title: "Commitment routing and pool matching",
    description:
      "Automated routing of commitments to appropriate pools using bioregion scoring, tag overlap, timeframe matching, and capacity analysis",
    declaration_type: "commitment",
    offer_type: "service",
    estimated_value_usd: 150,
    routing_tags: [
      "commitment-routing",
      "pool-matching",
      "resource-allocation",
    ],
  },
  {
    title: "Federation relay between bioregions",
    description:
      "Continuous KOI-net federation relay: event polling, signed envelope exchange, cross-reference tracking between Salish Sea, Front Range, Greater Victoria, and Cowichan Valley nodes",
    declaration_type: "commitment",
    offer_type: "service",
    estimated_value_usd: 100,
    routing_tags: [
      "federation",
      "koi-net",
      "cross-bioregion",
      "data-relay",
    ],
  },
];

// --- Octo's needs (what it requires) ---
const AGENT_NEEDS: CommitmentDef[] = [
  {
    title: "VPS compute infrastructure",
    description:
      "Monthly VPS hosting: 4 vCPU, 8GB RAM, 247GB disk at 45.132.245.30 running KOI backend, PostgreSQL, OpenClaw, Quartz, and federation services",
    declaration_type: "need",
    offer_type: "service",
    need_category: "compute",
    fiat_only: true,
    monthly_amount_usd: 150,
    estimated_value_usd: 150,
    routing_tags: ["compute", "hosting", "infrastructure", "vps"],
  },
  {
    title: "Database storage and backups",
    description:
      "PostgreSQL with pgvector for knowledge graph storage, daily automated backups with 7-day retention, off-host replication",
    declaration_type: "need",
    offer_type: "service",
    need_category: "storage",
    fiat_only: true,
    monthly_amount_usd: 50,
    estimated_value_usd: 50,
    routing_tags: ["storage", "database", "backups", "postgresql"],
  },
  {
    title: "LLM API credits",
    description:
      "OpenAI API credits for entity extraction (gpt-4o-mini), commitment extraction, embedding generation, and Whisper transcription",
    declaration_type: "need",
    offer_type: "service",
    need_category: "compute",
    fiat_only: false,
    monthly_amount_usd: 50,
    estimated_value_usd: 50,
    routing_tags: ["api-credits", "openai", "llm", "embeddings"],
  },
];

// --- API Helpers ---

async function resolveOrCreateEntity(
  name: string,
  type: string,
): Promise<string> {
  // Use entity/resolve which handles search + create in one call
  const resolveResp = await fetch(`${KOI_BASE}/entity/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: name,
      type_hint: type,
    }),
  });
  if (resolveResp.ok) {
    const result: any = await resolveResp.json();
    // resolve returns {candidates: [{uri, name, ...}], is_new}
    if (result.candidates?.length > 0) {
      return result.candidates[0].uri;
    }
    return result.entity_uri || result.fuseki_uri;
  }

  // Fallback: search
  const searchResp = await fetch(
    `${KOI_BASE}/entity-search?q=${encodeURIComponent(name)}&limit=1`,
  );
  if (searchResp.ok) {
    const results: any = await searchResp.json();
    if (results.length > 0) {
      return results[0].fuseki_uri;
    }
  }

  throw new Error(`Could not resolve entity: ${name}`);
}

async function createCommitment(
  pledgerUri: string,
  def: CommitmentDef,
): Promise<string> {
  const metadata: Record<string, any> = {
    routing_tags: def.routing_tags,
    estimated_value_usd: def.estimated_value_usd,
    declaration_type: def.declaration_type,
  };
  if (def.need_category) metadata.need_category = def.need_category;
  if (def.fiat_only !== undefined) metadata.fiat_only = def.fiat_only;
  if (def.monthly_amount_usd) metadata.monthly_amount_usd = def.monthly_amount_usd;

  const resp = await fetch(`${KOI_BASE}/commitments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pledger_uri: pledgerUri,
      title: def.title,
      description: def.description,
      offer_type: def.offer_type,
      metadata,
      created_by: "octo-agent",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to create commitment (${resp.status}): ${body}`);
  }

  const result: any = await resp.json();
  return result.commitment_rid;
}

async function verifyCommitment(rid: string): Promise<void> {
  const resp = await fetch(`${KOI_BASE}/commitments/${encodeURIComponent(rid)}/state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      new_state: "VERIFIED",
      actor: "octo-agent",
      reason: "Agent self-verification",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    // Ignore if already verified (idempotent)
    if (!body.includes("Invalid transition")) {
      throw new Error(`Failed to verify commitment (${resp.status}): ${body}`);
    }
  }
}

// --- Main ---

async function main() {
  console.log("\n=== Octo Agent Self-Commitment ===\n");
  console.log("Registering Octo's commitments (offers) and needs (thresholds)\n");

  // Resolve Octo as an entity
  console.log("Resolving Octo entity...");
  let octoUri: string;
  try {
    octoUri = await resolveOrCreateEntity(
      "Octo (Salish Sea Coordinator)",
      "Project",
    );
  } catch {
    // Fallback to known URI on Octo production
    octoUri = "orn:personal-koi.entity:project-octo-salish-sea-coordinator-f065";
  }
  console.log(`Octo entity: ${octoUri}\n`);

  const allDefs = [...AGENT_COMMITMENTS, ...AGENT_NEEDS];
  const createdRids: string[] = [];

  for (const def of allDefs) {
    const type = def.declaration_type === "need" ? "NEED" : "OFFER";
    console.log(`[${type}] ${def.title}`);

    try {
      const rid = await createCommitment(octoUri, def);
      console.log(`  Created: ${rid}`);

      await verifyCommitment(rid);
      console.log(`  Verified`);

      createdRids.push(rid);
    } catch (e: any) {
      console.warn(`  Warning: ${e.message}`);
    }
  }

  // Summary
  const offers = AGENT_COMMITMENTS.length;
  const needs = AGENT_NEEDS.length;
  const totalValue = allDefs.reduce((sum, d) => sum + (d.estimated_value_usd || 0), 0);
  const fiatThreshold = AGENT_NEEDS
    .filter((n) => n.fiat_only)
    .reduce((sum, n) => sum + (n.monthly_amount_usd || 0), 0);

  console.log(`\n=== Agent Self-Commitment Summary ===`);
  console.log(`Offers: ${offers} (total value: $${AGENT_COMMITMENTS.reduce((s, c) => s + (c.estimated_value_usd || 0), 0)})`);
  console.log(`Needs: ${needs} (total: $${AGENT_NEEDS.reduce((s, n) => s + (n.monthly_amount_usd || 0), 0)}/month)`);
  console.log(`Fiat-only threshold: $${fiatThreshold}/month`);
  console.log(`Created RIDs: ${createdRids.length}`);

  // Output RIDs for piping
  console.log(`\n--- RIDs ---`);
  for (const rid of createdRids) {
    console.log(rid);
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
