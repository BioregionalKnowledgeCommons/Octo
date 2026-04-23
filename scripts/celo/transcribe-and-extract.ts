import "dotenv/config";

// --- Config ---
const KOI_BASE = process.env.KOI_API_BASE_URL || "http://localhost:8351";
const KOI_CLAIMS_SERVICE_TOKEN = process.env.KOI_CLAIMS_SERVICE_TOKEN?.trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- Whisper Transcription ---

async function transcribeAudio(filePath: string): Promise<{ transcript: string; duration_seconds: number }> {
  if (!OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY not set");
    process.exit(1);
  }

  const fs = await import("fs");
  const path = await import("path");

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }

  const stat = fs.statSync(resolved);
  const sizeMB = stat.size / (1024 * 1024);
  console.log(`File: ${resolved} (${sizeMB.toFixed(1)} MB)`);

  if (sizeMB > 25) {
    console.error("Error: File exceeds Whisper API 25MB limit");
    process.exit(1);
  }

  console.log("Transcribing with OpenAI Whisper...");
  const startTime = Date.now();

  const formData = new FormData();
  const fileBuffer = fs.readFileSync(resolved);
  const blob = new Blob([fileBuffer]);
  const ext = path.extname(resolved).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
  };
  const mimeType = mimeMap[ext] || "audio/mpeg";
  const file = new File([blob], path.basename(resolved), { type: mimeType });
  formData.append("file", file);
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Whisper API failed (${resp.status}): ${body}`);
  }

  const result: any = await resp.json();
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`Transcription complete in ${elapsed.toFixed(1)}s`);

  return {
    transcript: result.text,
    duration_seconds: result.duration || 0,
  };
}

// --- Extract Commitments via KOI API ---

function getKoiWriteHeaders(): Record<string, string> {
  if (!KOI_CLAIMS_SERVICE_TOKEN) {
    throw new Error("KOI_CLAIMS_SERVICE_TOKEN not set in .env");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${KOI_CLAIMS_SERVICE_TOKEN}`,
  };
}

async function extractCommitments(
  transcript: string,
  sourceDocument: string,
  bioregion?: string,
  autoCreate: boolean = false,
): Promise<any> {
  console.log(`\nExtracting commitments from transcript (${transcript.length} chars)...`);

  const resp = await fetch(`${KOI_BASE}/commitments/extract-from-transcript`, {
    method: "POST",
    headers: getKoiWriteHeaders(),
    body: JSON.stringify({
      document_text: transcript,
      source_document: sourceDocument,
      bioregion: bioregion || "Salish Sea",
      confidence_threshold: 0.6,
      auto_create: autoCreate,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Extraction failed (${resp.status}): ${body}`);
  }

  return resp.json();
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log("Usage:");
    console.log("  npx tsx transcribe-and-extract.ts <audio-file>              Transcribe + extract");
    console.log("  npx tsx transcribe-and-extract.ts <audio-file> --auto-create  Also create commitments");
    console.log("  npx tsx transcribe-and-extract.ts --transcribe-only <file>    Transcribe only (stdout)");
    console.log("  npx tsx transcribe-and-extract.ts --extract-only <text-file>  Extract from text file");
    console.log("\nEnvironment:");
    console.log("  OPENAI_API_KEY         Required for transcription");
    console.log("  KOI_API_BASE_URL       KOI backend (default: http://localhost:8351)");
    process.exit(0);
  }

  const autoCreate = args.includes("--auto-create");

  if (args.includes("--transcribe-only")) {
    const fileArg = args[args.indexOf("--transcribe-only") + 1];
    if (!fileArg) {
      console.error("Error: --transcribe-only requires a file path");
      process.exit(1);
    }
    const { transcript, duration_seconds } = await transcribeAudio(fileArg);
    console.log(`\nDuration: ${duration_seconds.toFixed(1)}s`);
    console.log(`\n--- Transcript ---\n${transcript}\n--- End ---`);
    // Also output raw transcript for piping
    process.stdout.write(transcript);
    return;
  }

  if (args.includes("--extract-only")) {
    const fileArg = args[args.indexOf("--extract-only") + 1];
    if (!fileArg) {
      console.error("Error: --extract-only requires a text file path");
      process.exit(1);
    }
    const fs = await import("fs");
    const text = fs.readFileSync(fileArg, "utf-8");
    const result = await extractCommitments(text, fileArg, undefined, autoCreate);
    console.log(`\n${result.summary}`);
    console.log(`\nCandidates (${result.candidates.length}):`);
    for (const c of result.candidates) {
      const type = c.declaration_type === "need" ? "NEED" : "OFFER";
      console.log(`  [${type}] ${c.title} (${c.offer_type}, confidence=${c.confidence})`);
      if (c.declaration_type === "need") {
        console.log(`         need_category=${c.need_category} fiat_only=${c.fiat_only} monthly=$${c.monthly_amount_usd || "?"}`);
      }
    }
    if (result.auto_created?.length) {
      console.log(`\nAuto-created (${result.auto_created.length}):`);
      for (const a of result.auto_created) {
        console.log(`  ${a.status}: ${a.title} ${a.commitment_rid || a.reason || ""}`);
      }
    }
    return;
  }

  // Default: transcribe + extract
  const audioFile = args.find((a) => !a.startsWith("--"));
  if (!audioFile) {
    console.error("Error: No audio file specified");
    process.exit(1);
  }

  console.log("=== Transcribe + Extract Pipeline ===\n");

  // Step 1: Transcribe
  const { transcript, duration_seconds } = await transcribeAudio(audioFile);
  console.log(`Duration: ${duration_seconds.toFixed(1)}s`);
  console.log(`Transcript length: ${transcript.length} chars`);

  // Step 2: Extract
  const result = await extractCommitments(transcript, audioFile, "Salish Sea", autoCreate);

  // Step 3: Display
  console.log(`\n=== Extraction Results ===`);
  console.log(result.summary);

  const commitments = result.candidates.filter((c: any) => c.declaration_type !== "need");
  const needs = result.candidates.filter((c: any) => c.declaration_type === "need");

  if (commitments.length > 0) {
    console.log(`\nCommitments (${commitments.length}):`);
    for (const c of commitments) {
      console.log(`  - ${c.title} (${c.offer_type}, confidence=${c.confidence})`);
      console.log(`    ${c.description}`);
      if (c.estimated_value_usd) console.log(`    Value: $${c.estimated_value_usd}`);
    }
  }

  if (needs.length > 0) {
    console.log(`\nNeeds (${needs.length}):`);
    for (const n of needs) {
      console.log(`  - ${n.title} (${n.need_category || "general"}, fiat_only=${n.fiat_only})`);
      console.log(`    ${n.description}`);
      if (n.monthly_amount_usd) console.log(`    Monthly: $${n.monthly_amount_usd}`);
    }
  }

  if (result.auto_created?.length) {
    console.log(`\nAuto-created (${result.auto_created.length}):`);
    for (const a of result.auto_created) {
      console.log(`  ${a.status}: ${a.title} → ${a.commitment_rid || a.reason || ""}`);
    }
  }

  // Output JSON for piping
  console.log(`\n--- JSON ---`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
