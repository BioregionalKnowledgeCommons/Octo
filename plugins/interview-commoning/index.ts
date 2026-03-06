import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";

const OPENAI_API = "https://api.openai.com/v1/chat/completions";
const KOI_API = process.env.KOI_API_ENDPOINT || "http://127.0.0.1:8351";
const DEFAULT_MODEL = process.env.INTERVIEW_COMMONING_MODEL || process.env.GPT_MODEL || "gpt-4o-mini";

type JsonMap = Record<string, any>;

type IntakeRecord = {
  interview_id: string;
  title: string;
  node_id: string;
  bioregion: string;
  source_mode: string;
  participants: string[];
  interviewer?: string;
  consent_tier: string;
  share_scope: string;
  allowed_uses: string[];
  steward?: string;
  source_path?: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type ReviewPacket = {
  packet_type: string;
  packet_id: string;
  interview_id: string;
  title: string;
  summary: string;
  approval_status: string;
  share_policy: string;
  review?: JsonMap | null;
  [key: string]: any;
};

function success(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function error(message: string) {
  return { content: [{ type: "text", text: message }], isError: true as const };
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "untitled";
}

function noteName(input: string): string {
  return input.replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled";
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(3).toString("hex")}`;
}

function getVaultPath(): string {
  const p = process.env.VAULT_PATH;
  if (!p) throw new Error("VAULT_PATH environment variable must be set");
  return nodePath.resolve(p);
}

function getWorkspaceRoot(): string {
  const explicit = process.env.INTERVIEW_WORKSPACE_PATH;
  if (explicit) return nodePath.resolve(explicit);
  const vaultRoot = getVaultPath();
  const parent = nodePath.dirname(vaultRoot);
  if (nodePath.basename(parent) === "workspace") return parent;
  if (nodePath.basename(vaultRoot) === "vault") return nodePath.join(parent, "workspace");
  return parent;
}

function getNodeId(): string {
  return process.env.KOI_NODE_NAME || process.env.INTERVIEW_NODE_NAME || "local-node";
}

function safeRootedPath(root: string, relativePath: string): string {
  const resolvedRoot = nodePath.resolve(root);
  const resolved = nodePath.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(resolvedRoot + nodePath.sep) && resolved !== resolvedRoot) {
    throw new Error(`Path traversal rejected: ${relativePath}`);
  }
  return resolved;
}

function safeVaultPath(relativePath: string): string {
  return safeRootedPath(getVaultPath(), relativePath);
}

function safeWorkspacePath(relativePath: string): string {
  return safeRootedPath(getWorkspaceRoot(), relativePath);
}

function allowedImportPrefixes(): string[] {
  const home = os.homedir();
  return [
    getWorkspaceRoot(),
    getVaultPath(),
    nodePath.join(home, "Downloads"),
    nodePath.join(home, "Documents", "AudioTranscriptions"),
  ].map((p) => nodePath.resolve(p));
}

function safeImportPath(inputPath: string): string {
  const expanded = inputPath.replace(/^~(?=$|\/|\\)/, os.homedir());
  const resolved = nodePath.isAbsolute(expanded)
    ? nodePath.resolve(expanded)
    : nodePath.resolve(getWorkspaceRoot(), expanded);
  const allowed = allowedImportPrefixes();
  if (!allowed.some((prefix) => resolved === prefix || resolved.startsWith(prefix + nodePath.sep))) {
    throw new Error(`Transcript import path must be under one of: ${allowed.join(", ")}`);
  }
  return resolved;
}

async function ensureInterviewDirs(): Promise<void> {
  const dirs = [
    safeWorkspacePath("interviews/intake"),
    safeWorkspacePath("interviews/transcripts"),
    safeWorkspacePath("interviews/review"),
    safeWorkspacePath("interviews/publication"),
    safeWorkspacePath("protocol-library"),
  ];
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
}

async function readJsonFile<T>(fullPath: string): Promise<T> {
  return JSON.parse(await fs.readFile(fullPath, "utf-8")) as T;
}

async function writeJsonFile(fullPath: string, data: unknown): Promise<void> {
  await fs.mkdir(nodePath.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function readIntake(interviewId: string): Promise<IntakeRecord> {
  return readJsonFile<IntakeRecord>(safeWorkspacePath(`interviews/intake/${interviewId}.json`));
}

async function writeIntake(intake: IntakeRecord): Promise<void> {
  intake.updated_at = nowIso();
  await writeJsonFile(safeWorkspacePath(`interviews/intake/${intake.interview_id}.json`), intake);
}

async function maybeReadText(fullPath: string): Promise<string | null> {
  try {
    return await fs.readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}

async function appendJsonLine(fullPath: string, data: unknown): Promise<void> {
  await fs.mkdir(nodePath.dirname(fullPath), { recursive: true });
  await fs.appendFile(fullPath, JSON.stringify(data) + "\n", "utf-8");
}

async function listReviewPackets(interviewId: string): Promise<Array<{ path: string; packet: ReviewPacket }>> {
  const reviewDir = safeWorkspacePath(`interviews/review/${interviewId}`);
  try {
    const files = (await fs.readdir(reviewDir))
      .filter((name) => name.endsWith(".json") && name !== "transcript-package.json" && name !== "extraction-bundle.json" && name !== "publication-manifest.json")
      .sort();
    const packets = await Promise.all(
      files.map(async (name) => ({
        path: `interviews/review/${interviewId}/${name}`,
        packet: await readJsonFile<ReviewPacket>(nodePath.join(reviewDir, name)),
      })),
    );
    return packets;
  } catch {
    return [];
  }
}

async function loadTranscriptText(interviewId: string): Promise<string> {
  const transcriptPath = safeWorkspacePath(`interviews/transcripts/${interviewId}.transcript.md`);
  const transcript = await maybeReadText(transcriptPath);
  if (transcript) return transcript;

  const turnsPath = safeWorkspacePath(`interviews/transcripts/${interviewId}.turns.jsonl`);
  const turnsRaw = await maybeReadText(turnsPath);
  if (!turnsRaw) throw new Error(`No transcript found for ${interviewId}`);

  const lines = turnsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { speaker: string; text: string; timestamp: string });

  if (lines.length === 0) throw new Error(`No transcript turns found for ${interviewId}`);

  const transcriptBody = lines.map((line) => `${line.speaker}: ${line.text}`).join("\n\n");
  const markdown = `# Interview Transcript - ${interviewId}\n\n${transcriptBody}\n`;
  await fs.writeFile(transcriptPath, markdown, "utf-8");
  return markdown;
}

function yamlKey(key: string): string {
  return /[^a-zA-Z0-9_]/.test(key) ? `"${key}"` : key;
}

function renderFrontmatter(frontmatter: JsonMap): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === "") continue;
    const k = yamlKey(key);
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of value) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
      continue;
    }
    if (typeof value === "object") {
      lines.push(`${k}: ${yamlScalar(JSON.stringify(value))}`);
      continue;
    }
    lines.push(`${k}: ${yamlScalar(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const str = String(value).replace(/\n/g, " ");
  if (/^\[\[.*\]\]$/.test(str)) return `"${str.replace(/"/g, '\\"')}"`;
  return `"${str.replace(/"/g, '\\"')}"`;
}

function noteFolderForType(type: string): string {
  const map: Record<string, string> = {
    Person: "People",
    Organization: "Organizations",
    Project: "Projects",
    Location: "Locations",
    Concept: "Concepts",
    Meeting: "Meetings",
    Bioregion: "Bioregions",
    Practice: "Practices",
    Pattern: "Patterns",
    CaseStudy: "CaseStudies",
    Protocol: "Protocols",
    Playbook: "Playbooks",
    Question: "Questions",
    Claim: "Claims",
    Evidence: "Evidence",
  };
  return map[type] || "Concepts";
}

function vaultRidFor(type: string, title: string): string {
  return `orn:openclaw.entity:${noteFolderForType(type)}/${slugify(title)}`;
}

async function koiRequest(path: string, method = "GET", body?: unknown) {
  const url = `${KOI_API}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KOI API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function openAiExtract(intake: IntakeRecord, transcriptText: string, model: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY must be set for interview extraction");
  }

  const system = [
    "You extract graph-ready interview artifacts for the Bioregional Knowledge Commons.",
    "The canonical ontology layer is graph-first and uses these entity types where applicable: Practice, Pattern, Protocol, Question, Claim, Evidence, Organization, Location, Bioregion, Concept, Project, Meeting.",
    "Return strict JSON only.",
    "Practices are local and concrete.",
    "Patterns are trans-local abstractions emerging from one or more practices.",
    "Protocols are reusable coordination methods or pattern libraries that others could adapt.",
    "When you reference derived_from_practice_titles or derived_from_pattern_titles, reuse the exact titles from the practices/patterns arrays.",
    "Do not invent facts not grounded in the transcript.",
    "Prefer fewer, higher-quality artifacts over speculative lists.",
  ].join(" ");

  const user = {
    intake,
    transcript: transcriptText,
    response_shape: {
      summary: "string",
      practices: [
        {
          title: "string",
          summary: "string",
          bioregion: "string",
          organizations: ["string"],
          locations: ["string"],
          questions: ["string"],
          claims: ["string"],
          evidence_snippets: ["string"],
          local_terms: ["string"],
          share_sensitivity: "low|medium|high",
        },
      ],
      patterns: [
        {
          title: "string",
          summary: "string",
          derived_from_practice_titles: ["string"],
          applicability_notes: "string",
          supporting_evidence: ["string"],
          confidence: 0.0,
        },
      ],
      protocols: [
        {
          title: "string",
          summary: "string",
          derived_from_practice_titles: ["string"],
          derived_from_pattern_titles: ["string"],
          constraints: "string",
          applicability_notes: "string",
          confidence: 0.0,
        },
      ],
      questions: [{ title: "string", summary: "string" }],
      claims: [{ title: "string", summary: "string" }],
      evidence: [{ title: "string", summary: "string", supports_claim_titles: ["string"] }],
    },
  };

  const res = await fetch(OPENAI_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI extraction failed (${res.status}): ${text}`);
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI extraction returned no content");
  }
  return JSON.parse(content);
}

function ensureArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function summarizePackets(packets: ReviewPacket[]): string {
  return packets
    .map((packet) => `- ${packet.packet_type}: ${packet.title} [${packet.approval_status}] (${packet.share_policy})`)
    .join("\n");
}

function recommendedSharePolicy(sensitivity: string): string {
  if (sensitivity === "low") return "shared_summary";
  if (sensitivity === "medium") return "steward_review_required";
  return "local_only";
}

function extractBundleToPackets(interviewId: string, intake: IntakeRecord, extracted: JsonMap) {
  const practices = Array.isArray(extracted.practices) ? extracted.practices : [];
  const patterns = Array.isArray(extracted.patterns) ? extracted.patterns : [];
  const protocols = Array.isArray(extracted.protocols) ? extracted.protocols : [];
  const questions = Array.isArray(extracted.questions) ? extracted.questions : [];
  const claims = Array.isArray(extracted.claims) ? extracted.claims : [];
  const evidence = Array.isArray(extracted.evidence) ? extracted.evidence : [];

  const practiceIdByTitle = new Map<string, string>();
  const practicePackets: ReviewPacket[] = practices.map((practice: any, index: number) => {
    const title = String(practice.title || `Practice ${index + 1}`).trim();
    const packetId = `practice-${slugify(title)}`;
    practiceIdByTitle.set(title, packetId);
    return {
      packet_type: "PracticePacket",
      packet_id: packetId,
      interview_id: interviewId,
      title,
      summary: String(practice.summary || "").trim(),
      bioregion: String(practice.bioregion || intake.bioregion || "").trim(),
      organizations: ensureArray(practice.organizations),
      locations: ensureArray(practice.locations),
      questions: ensureArray(practice.questions),
      claims: ensureArray(practice.claims),
      evidence_snippets: ensureArray(practice.evidence_snippets),
      local_terms: ensureArray(practice.local_terms),
      local_type: "Practice",
      canonical_type: "Practice",
      mapping_status: "equivalent",
      share_policy: "local_only",
      recommended_share_policy: recommendedSharePolicy(String(practice.share_sensitivity || "high")),
      approval_status: "pending_review",
      review: null,
      created_at: nowIso(),
    };
  });

  const patternPackets: ReviewPacket[] = patterns.map((pattern: any, index: number) => {
    const title = String(pattern.title || `Pattern ${index + 1}`).trim();
    const derived = ensureArray(pattern.derived_from_practice_titles)
      .map((name) => practiceIdByTitle.get(name))
      .filter(Boolean);
    return {
      packet_type: "PatternCandidatePacket",
      packet_id: `pattern-${slugify(title)}`,
      interview_id: interviewId,
      title,
      summary: String(pattern.summary || "").trim(),
      derived_from_practice_ids: derived,
      evidence_refs: ensureArray(pattern.supporting_evidence),
      applicability_notes: String(pattern.applicability_notes || "").trim(),
      confidence: Number(pattern.confidence || 0.5),
      share_policy: "federated_derived",
      approval_status: "pending_review",
      derivation_status: "candidate_local",
      review: null,
      created_at: nowIso(),
    };
  });

  const patternIdByTitle = new Map<string, string>();
  for (const packet of patternPackets) patternIdByTitle.set(packet.title, packet.packet_id);

  const protocolPackets: ReviewPacket[] = protocols.map((protocol: any, index: number) => {
    const title = String(protocol.title || `Protocol ${index + 1}`).trim();
    return {
      packet_type: "ProtocolCandidatePacket",
      packet_id: `protocol-${slugify(title)}`,
      interview_id: interviewId,
      title,
      summary: String(protocol.summary || "").trim(),
      derived_from_practice_ids: ensureArray(protocol.derived_from_practice_titles)
        .map((name) => practiceIdByTitle.get(name))
        .filter(Boolean),
      derived_from_pattern_ids: ensureArray(protocol.derived_from_pattern_titles)
        .map((name) => patternIdByTitle.get(name))
        .filter(Boolean),
      constraints: String(protocol.constraints || "").trim(),
      applicability_notes: String(protocol.applicability_notes || "").trim(),
      confidence: Number(protocol.confidence || 0.5),
      share_policy: "federated_derived",
      approval_status: "pending_review",
      derivation_status: "candidate_local",
      review: null,
      created_at: nowIso(),
    };
  });

  return {
    summary: String(extracted.summary || "").trim(),
    questions,
    claims,
    evidence,
    packets: [...practicePackets, ...patternPackets, ...protocolPackets],
  };
}

function packetBody(packet: ReviewPacket, intake: IntakeRecord, extra: { about?: string[]; documents?: string[] } = {}): { frontmatter: JsonMap; content: string } {
  const tagBase = packet.packet_type
    .replace(/CandidatePacket$/, "")
    .replace(/Packet$/, "")
    .toLowerCase();
  const tags = [tagBase, "interview-commoning"].filter(Boolean);
  const frontmatter: JsonMap = {
    "@type": `bkc:${packet.packet_type.replace(/CandidatePacket$/, "").replace(/Packet$/, "")}`,
    name: packet.title,
    description: packet.summary,
    sourceNode: intake.node_id,
    sourceBioregion: intake.bioregion,
    derivationStatus: packet.derivation_status,
    shareScope: packet.share_policy,
    requestAccessVia: intake.steward || intake.node_id,
    reviewedBy: packet.review?.reviewer || "",
    derivedFromPracticeIds: packet.derived_from_practice_ids || [],
    derivedFromPatternIds: packet.derived_from_pattern_ids || [],
    tags,
  };
  if (extra.about && extra.about.length > 0) frontmatter.about = extra.about;
  if (extra.documents && extra.documents.length > 0) frontmatter.documents = extra.documents;

  const content = [
    renderFrontmatter(frontmatter),
    "",
    `# ${packet.title}`,
    "",
    packet.summary,
    "",
    "## Derivation",
    "",
    `- Source node: ${intake.node_id}`,
    `- Source bioregion: ${intake.bioregion}`,
    `- Share policy: ${packet.share_policy}`,
    packet.review?.notes ? `- Review notes: ${packet.review.notes}` : "- Review notes: none recorded",
    "",
    "Supporting local interview material remains in the source commons unless separately approved for sharing.",
    "",
  ].join("\n");

  return { frontmatter, content };
}

async function writeNoteIfMissing(type: string, title: string, content: string): Promise<{ path: string; created: boolean }> {
  const relativePath = `${noteFolderForType(type)}/${noteName(title)}.md`;
  const fullPath = safeVaultPath(relativePath);
  await fs.mkdir(nodePath.dirname(fullPath), { recursive: true });
  try {
    await fs.access(fullPath);
    return { path: relativePath, created: false };
  } catch {
    await fs.writeFile(fullPath, content, "utf-8");
    return { path: relativePath, created: true };
  }
}

async function registerNote(type: string, title: string, relativePath: string, frontmatter: JsonMap, content: string) {
  return koiRequest("/register-entity", "POST", {
    vault_rid: vaultRidFor(type, title),
    vault_path: relativePath,
    entity_type: type,
    name: title,
    properties: {},
    frontmatter,
    content_hash: sha256(content),
  });
}

function packetTypeToEntityType(packetType: string): string {
  if (packetType.includes("Pattern")) return "Pattern";
  if (packetType.includes("Protocol")) return "Protocol";
  if (packetType.includes("CaseStudy")) return "CaseStudy";
  if (packetType.includes("Practice")) return "Practice";
  return "Concept";
}

const interviewCommoningPlugin = {
  id: "interview-commoning",
  name: "Interview Commoning",
  description: "Local interview intake, extraction, review, and derived-artifact publication tools for inter-bioregional learning.",
  register(api: OpenClawPluginApi) {
    api.registerTool(
      {
        name: "interview_intake_create",
        description: "Create a local interview intake record for the inter-bioregional learning MVP.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Interview title or short label" },
            bioregion: { type: "string", description: "Bioregion grounding for this interview" },
            source_mode: { type: "string", description: "chat, transcript, or audio_import" },
            participants: { type: "array", items: { type: "string" } },
            interviewer: { type: "string" },
            consent_tier: { type: "string", description: "public, restricted, private, or community_only" },
            share_scope: { type: "string", description: "local, bioregion, or cross_bioregion" },
            allowed_uses: { type: "array", items: { type: "string" } },
            steward: { type: "string" },
            source_path: { type: "string" },
          },
          required: ["title", "bioregion", "source_mode"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            await ensureInterviewDirs();
            const title = String(params.title || "Interview").trim();
            const interviewId = uniqueId(`${new Date().toISOString().slice(0, 10)}-${slugify(title)}`);
            const intake: IntakeRecord = {
              interview_id: interviewId,
              title,
              node_id: getNodeId(),
              bioregion: String(params.bioregion || "").trim(),
              source_mode: String(params.source_mode || "chat").trim(),
              participants: Array.isArray(params.participants) ? (params.participants as string[]).map((v) => String(v)) : [],
              interviewer: params.interviewer ? String(params.interviewer) : undefined,
              consent_tier: String(params.consent_tier || "private"),
              share_scope: String(params.share_scope || "local"),
              allowed_uses: Array.isArray(params.allowed_uses) ? (params.allowed_uses as string[]).map((v) => String(v)) : ["research", "pattern_mining"],
              steward: params.steward ? String(params.steward) : undefined,
              source_path: params.source_path ? String(params.source_path) : undefined,
              status: "intake_created",
              created_at: nowIso(),
              updated_at: nowIso(),
            };
            await writeIntake(intake);
            return success({
              success: true,
              interview_id: interviewId,
              intake_path: `interviews/intake/${interviewId}.json`,
              transcript_path: `interviews/transcripts/${interviewId}.transcript.md`,
              turns_path: `interviews/transcripts/${interviewId}.turns.jsonl`,
            });
          } catch (e: any) {
            return error(e.message);
          }
        },
      },
      { names: ["interview_intake_create"] },
    );

    api.registerTool(
      {
        name: "interview_turn_append",
        description: "Append a chat turn to a local interview session.",
        parameters: {
          type: "object",
          properties: {
            interview_id: { type: "string" },
            speaker: { type: "string" },
            text: { type: "string" },
            timestamp: { type: "string" },
          },
          required: ["interview_id", "speaker", "text"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            await ensureInterviewDirs();
            const interviewId = String(params.interview_id);
            const intake = await readIntake(interviewId);
            const turnsPath = safeWorkspacePath(`interviews/transcripts/${interviewId}.turns.jsonl`);
            await appendJsonLine(turnsPath, {
              speaker: String(params.speaker),
              text: String(params.text),
              timestamp: String(params.timestamp || nowIso()),
            });
            intake.status = "capturing_chat";
            await writeIntake(intake);
            const lineCount = (await fs.readFile(turnsPath, "utf-8")).split(/\r?\n/).filter(Boolean).length;
            return success({ success: true, interview_id: interviewId, turns_recorded: lineCount, turns_path: `interviews/transcripts/${interviewId}.turns.jsonl` });
          } catch (e: any) {
            return error(e.message);
          }
        },
      },
      { names: ["interview_turn_append"] },
    );

    api.registerTool(
      {
        name: "interview_transcript_import",
        description: "Import a reviewed transcript into a local interview record from text or an allowed file path.",
        parameters: {
          type: "object",
          properties: {
            interview_id: { type: "string" },
            transcript_text: { type: "string" },
            transcript_path: { type: "string" },
            source_type: { type: "string", description: "manual, otter, macwhisper, or reviewed_text" },
          },
          required: ["interview_id"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            await ensureInterviewDirs();
            const interviewId = String(params.interview_id);
            const intake = await readIntake(interviewId);
            let transcriptText = params.transcript_text ? String(params.transcript_text) : "";
            let importedFrom = "inline";
            if (!transcriptText && params.transcript_path) {
              const importPath = safeImportPath(String(params.transcript_path));
              transcriptText = await fs.readFile(importPath, "utf-8");
              importedFrom = importPath;
            }
            if (!transcriptText.trim()) {
              throw new Error("Provide transcript_text or transcript_path");
            }
            const sourceType = String(params.source_type || "reviewed_text");
            const markdown = [
              `# Interview Transcript - ${interviewId}`,
              "",
              `**Source type:** ${sourceType}`,
              `**Imported from:** ${importedFrom}`,
              "",
              "---",
              "",
              transcriptText.trim(),
              "",
            ].join("\n");
            await fs.writeFile(safeWorkspacePath(`interviews/transcripts/${interviewId}.transcript.md`), markdown, "utf-8");
            intake.status = "transcript_imported";
            intake.source_mode = intake.source_mode || "transcript";
            intake.source_path = importedFrom;
            await writeIntake(intake);
            return success({ success: true, interview_id: interviewId, transcript_path: `interviews/transcripts/${interviewId}.transcript.md`, imported_from: importedFrom });
          } catch (e: any) {
            return error(e.message);
          }
        },
      },
      { names: ["interview_transcript_import"] },
    );

    api.registerTool(
      {
        name: "interview_session_finalize",
        description: "Normalize a local interview, extract practice/pattern/protocol candidates, and write review packets.",
        parameters: {
          type: "object",
          properties: {
            interview_id: { type: "string" },
            model: { type: "string" },
          },
          required: ["interview_id"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            await ensureInterviewDirs();
            const interviewId = String(params.interview_id);
            const intake = await readIntake(interviewId);
            const transcriptText = await loadTranscriptText(interviewId);
            const model = String(params.model || DEFAULT_MODEL);
            const extracted = await openAiExtract(intake, transcriptText, model);
            const packetBundle = extractBundleToPackets(interviewId, intake, extracted);
            const reviewDir = safeWorkspacePath(`interviews/review/${interviewId}`);
            await fs.mkdir(reviewDir, { recursive: true });

            const transcriptPackage = {
              interview_id: interviewId,
              title: intake.title,
              source_mode: intake.source_mode,
              transcript_path: `interviews/transcripts/${interviewId}.transcript.md`,
              transcript_sha256: sha256(transcriptText),
              speaker_map: Array.from(new Set(transcriptText.split(/\r?\n/).map((line) => line.split(":")[0]?.trim()).filter(Boolean))),
              reviewed_by: intake.steward || intake.interviewer || getNodeId(),
              redaction_notes: [],
              created_at: nowIso(),
            };

            await writeJsonFile(nodePath.join(reviewDir, "transcript-package.json"), transcriptPackage);
            await writeJsonFile(nodePath.join(reviewDir, "extraction-bundle.json"), extracted);

            for (const packet of packetBundle.packets) {
              await writeJsonFile(nodePath.join(reviewDir, `${packet.packet_id}.json`), packet);
            }

            const summaryLines = [
              `# Interview Review Summary - ${interviewId}`,
              "",
              packetBundle.summary || "No summary generated.",
              "",
              "## Candidate Packets",
              "",
              summarizePackets(packetBundle.packets),
              "",
            ];
            await fs.writeFile(nodePath.join(reviewDir, "SUMMARY.md"), summaryLines.join("\n"), "utf-8");

            intake.status = "extracted_pending_review";
            await writeIntake(intake);

            return success({
              success: true,
              interview_id: interviewId,
              summary: packetBundle.summary,
              review_dir: `interviews/review/${interviewId}`,
              packet_counts: {
                total: packetBundle.packets.length,
                practices: packetBundle.packets.filter((p) => p.packet_type === "PracticePacket").length,
                patterns: packetBundle.packets.filter((p) => p.packet_type === "PatternCandidatePacket").length,
                protocols: packetBundle.packets.filter((p) => p.packet_type === "ProtocolCandidatePacket").length,
              },
            });
          } catch (e: any) {
            return error(e.message);
          }
        },
      },
      { names: ["interview_session_finalize"] },
    );

    api.registerTool(
      {
        name: "interview_list_artifacts",
        description: "List local interview intakes or review packets.",
        parameters: {
          type: "object",
          properties: {
            interview_id: { type: "string" },
          },
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            await ensureInterviewDirs();
            const interviewId = params.interview_id ? String(params.interview_id) : "";
            if (!interviewId) {
              const intakeDir = safeWorkspacePath("interviews/intake");
              const files = (await fs.readdir(intakeDir)).filter((name) => name.endsWith(".json")).sort();
              const intakes = await Promise.all(files.map(async (name) => readJsonFile<IntakeRecord>(nodePath.join(intakeDir, name))));
              return success({
                success: true,
                interviews: intakes.map((intake) => ({
                  interview_id: intake.interview_id,
                  title: intake.title,
                  bioregion: intake.bioregion,
                  source_mode: intake.source_mode,
                  status: intake.status,
                  updated_at: intake.updated_at,
                })),
              });
            }
            const intake = await readIntake(interviewId);
            const packets = await listReviewPackets(interviewId);
            const manifestPath = safeWorkspacePath(`interviews/publication/${interviewId}/manifest.json`);
            const manifest = await maybeReadText(manifestPath);
            return success({
              success: true,
              intake,
              packets: packets.map(({ path, packet }) => ({
                path,
                packet_type: packet.packet_type,
                packet_id: packet.packet_id,
                title: packet.title,
                approval_status: packet.approval_status,
                share_policy: packet.share_policy,
                derivation_status: packet.derivation_status || null,
              })),
              publication_manifest: manifest ? `interviews/publication/${interviewId}/manifest.json` : null,
            });
          } catch (e: any) {
            return error(e.message);
          }
        },
      },
      { names: ["interview_list_artifacts"] },
    );

    api.registerTool(
      {
        name: "interview_read_artifact",
        description: "Read a local interview artifact from the workspace.",
        parameters: {
          type: "object",
          properties: {
            artifact_path: { type: "string", description: "Relative path under the workspace, for example interviews/review/<id>/SUMMARY.md" },
          },
          required: ["artifact_path"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const artifactPath = String(params.artifact_path);
            const fullPath = safeWorkspacePath(artifactPath);
            const content = await fs.readFile(fullPath, "utf-8");
            return { content: [{ type: "text", text: content }] };
          } catch (e: any) {
            return error(e.message);
          }
        },
      },
      { names: ["interview_read_artifact"] },
    );

    api.registerTool(
      {
        name: "interview_review_packet",
        description: "Apply a human review decision to a local candidate packet.",
        parameters: {
          type: "object",
          properties: {
            packet_path: { type: "string", description: "Relative path under interviews/review/..." },
            approval_status: { type: "string", description: "approved_local, approved_shared, needs_revision, or rejected" },
            reviewer: { type: "string" },
            notes: { type: "string" },
            share_policy: { type: "string" },
            derivation_status: { type: "string" },
          },
          required: ["packet_path", "approval_status", "reviewer"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const packetPath = String(params.packet_path);
            const fullPath = safeWorkspacePath(packetPath);
            const packet = await readJsonFile<ReviewPacket>(fullPath);
            packet.approval_status = String(params.approval_status);
            packet.share_policy = params.share_policy ? String(params.share_policy) : packet.share_policy;
            packet.review = {
              reviewer: String(params.reviewer),
              reviewed_at: nowIso(),
              notes: params.notes ? String(params.notes) : "",
            };
            if (params.derivation_status) {
              packet.derivation_status = String(params.derivation_status);
            } else if (packet.packet_type === "PatternCandidatePacket" || packet.packet_type === "ProtocolCandidatePacket") {
              if (packet.approval_status === "approved_shared") packet.derivation_status = "provisional_shared";
              if (packet.approval_status === "approved_local") packet.derivation_status = packet.derivation_status || "candidate_local";
            }
            await writeJsonFile(fullPath, packet);
            return success({ success: true, packet_path: packetPath, packet });
          } catch (e: any) {
            return error(e.message);
          }
        },
      },
      { names: ["interview_review_packet"] },
    );

    api.registerTool(
      {
        name: "interview_publish_approved",
        description: "Publish approved shared patterns, protocols, and optional redacted case studies into the KOI graph and local vault.",
        parameters: {
          type: "object",
          properties: {
            interview_id: { type: "string" },
            publish_case_studies: { type: "boolean" },
          },
          required: ["interview_id"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            await ensureInterviewDirs();
            const interviewId = String(params.interview_id);
            const intake = await readIntake(interviewId);
            const packets = (await listReviewPackets(interviewId)).map(({ packet }) => packet);
            const publishCaseStudies = params.publish_case_studies !== false;

            const sharedPatterns = packets.filter((packet) => packet.packet_type === "PatternCandidatePacket" && packet.approval_status === "approved_shared");
            const sharedProtocols = packets.filter((packet) => packet.packet_type === "ProtocolCandidatePacket" && packet.approval_status === "approved_shared");
            const sharedPracticeSummaries = publishCaseStudies
              ? packets.filter((packet) => packet.packet_type === "PracticePacket" && (packet.approval_status === "approved_local" || packet.approval_status === "approved_shared") && packet.share_policy === "shared_summary")
              : [];

            if (sharedPatterns.length === 0 && sharedProtocols.length === 0 && sharedPracticeSummaries.length === 0) {
              throw new Error("No approved shared packets found. Approve at least one pattern, protocol, or shared_summary practice first.");
            }

            const entities: Array<{ name: string; type: string; context?: string; confidence?: number }> = [];
            const relationships: Array<{ subject: string; predicate: string; object: string; confidence?: number }> = [];
            const entityKey = new Set<string>();
            const addEntity = (name: string, type: string, context?: string) => {
              const key = `${type}:${name}`;
              if (entityKey.has(key)) return;
              entityKey.add(key);
              entities.push({ name, type, context, confidence: 0.95 });
            };

            addEntity(intake.bioregion, "Bioregion", `Source bioregion for ${interviewId}`);
            for (const packet of [...sharedPatterns, ...sharedProtocols]) {
              addEntity(packet.title, packetTypeToEntityType(packet.packet_type), packet.summary);
            }

            const publicPatternByPracticeId = new Map<string, string[]>();
            for (const pattern of sharedPatterns) {
              for (const practiceId of ensureArray(pattern.derived_from_practice_ids)) {
                const current = publicPatternByPracticeId.get(practiceId) || [];
                current.push(pattern.title);
                publicPatternByPracticeId.set(practiceId, current);
              }
            }

            const publicProtocolByPracticeId = new Map<string, string[]>();
            for (const protocol of sharedProtocols) {
              for (const practiceId of ensureArray(protocol.derived_from_practice_ids)) {
                const current = publicProtocolByPracticeId.get(practiceId) || [];
                current.push(protocol.title);
                publicProtocolByPracticeId.set(practiceId, current);
              }
            }

            const caseStudyPackets: ReviewPacket[] = sharedPracticeSummaries.map((practice) => ({
              packet_type: "CaseStudyPacket",
              packet_id: `case-study-${slugify(practice.title)}`,
              interview_id: interviewId,
              title: `${practice.title} Case`,
              summary: `Redacted case study from ${intake.bioregion}: ${practice.summary}`,
              approval_status: "approved_shared",
              share_policy: "shared_summary",
              derivation_status: "provisional_shared",
              review: practice.review,
              derived_from_practice_ids: [practice.packet_id],
              linked_pattern_titles: publicPatternByPracticeId.get(practice.packet_id) || [],
              linked_protocol_titles: publicProtocolByPracticeId.get(practice.packet_id) || [],
            }));

            for (const caseStudy of caseStudyPackets) {
              addEntity(caseStudy.title, "CaseStudy", caseStudy.summary);
            }

            for (const protocol of sharedProtocols) {
              relationships.push({ subject: protocol.title, predicate: "about", object: intake.bioregion, confidence: 0.95 });
              for (const patternId of ensureArray(protocol.derived_from_pattern_ids)) {
                const pattern = sharedPatterns.find((candidate) => candidate.packet_id === patternId);
                if (pattern) {
                  relationships.push({ subject: protocol.title, predicate: "about", object: pattern.title, confidence: 0.95 });
                }
              }
            }

            for (const caseStudy of caseStudyPackets) {
              relationships.push({ subject: caseStudy.title, predicate: "about", object: intake.bioregion, confidence: 0.95 });
              for (const patternTitle of ensureArray(caseStudy.linked_pattern_titles)) {
                relationships.push({ subject: caseStudy.title, predicate: "documents", object: patternTitle, confidence: 0.95 });
              }
              for (const protocolTitle of ensureArray(caseStudy.linked_protocol_titles)) {
                relationships.push({ subject: caseStudy.title, predicate: "about", object: protocolTitle, confidence: 0.95 });
              }
            }

            const documentRid = `interview-commoning:${getNodeId()}:${interviewId}:approved-manifest`;
            const source = `interview-commoning:${getNodeId()}`;
            const content = [
              `Approved inter-bioregional learning artifacts for ${interviewId}.`,
              `Patterns: ${sharedPatterns.map((packet) => packet.title).join(", ") || "none"}.`,
              `Protocols: ${sharedProtocols.map((packet) => packet.title).join(", ") || "none"}.`,
              `Case studies: ${caseStudyPackets.map((packet) => packet.title).join(", ") || "none"}.`,
            ].join(" ");

            const ingestResult = await koiRequest("/ingest", "POST", {
              document_rid: documentRid,
              source,
              content,
              entities,
              relationships,
            });

            const noteResults: Array<{ title: string; type: string; path: string; created: boolean }> = [];
            const warnings: string[] = [];
            const notePackets = [...sharedPatterns, ...sharedProtocols, ...caseStudyPackets];
            for (const packet of notePackets) {
              const type = packetTypeToEntityType(packet.packet_type);
              const relatedPatterns = type === "Protocol"
                ? ensureArray(packet.derived_from_pattern_ids)
                    .map((patternId) => sharedPatterns.find((candidate) => candidate.packet_id === patternId))
                    .filter(Boolean)
                    .map((pattern) => `[[Patterns/${noteName((pattern as ReviewPacket).title)}]]`)
                : [];
              const aboutLinks = [
                ...(type === "Protocol" ? relatedPatterns : []),
                ...(type === "Protocol" || type === "CaseStudy" ? [`[[Bioregions/${noteName(intake.bioregion)}]]`] : []),
                ...(type === "CaseStudy" ? ensureArray((packet as any).linked_protocol_titles).map((title) => `[[Protocols/${noteName(title)}]]`) : []),
              ];
              const documentsLinks = type === "CaseStudy"
                ? ensureArray((packet as any).linked_pattern_titles).map((title) => `[[Patterns/${noteName(title)}]]`)
                : [];
              const note = packetBody(packet, intake, { about: aboutLinks, documents: documentsLinks });
              const writeResult = await writeNoteIfMissing(type, packet.title, note.content);
              noteResults.push({ title: packet.title, type, path: writeResult.path, created: writeResult.created });
              if (!writeResult.created) {
                warnings.push(`Skipped overwriting existing ${type} note: ${writeResult.path}`);
                continue;
              }
              await registerNote(type, packet.title, writeResult.path, note.frontmatter, note.content);
            }

            const manifest = {
              manifest_id: `${interviewId}-manifest`,
              interview_id: interviewId,
              node_id: intake.node_id,
              bioregion: intake.bioregion,
              document_rid: documentRid,
              source,
              published_at: nowIso(),
              publish_entities: entities,
              publish_relationships: relationships,
              note_results: noteResults,
              warnings,
              ingest_result: {
                receipt_rid: ingestResult.receipt_rid,
                stats: ingestResult.stats,
              },
            };

            const publicationDir = safeWorkspacePath(`interviews/publication/${interviewId}`);
            await fs.mkdir(publicationDir, { recursive: true });
            await writeJsonFile(nodePath.join(publicationDir, "manifest.json"), manifest);

            intake.status = "published_shared_artifacts";
            await writeIntake(intake);

            return success({ success: true, manifest_path: `interviews/publication/${interviewId}/manifest.json`, note_results: noteResults, warnings, ingest_result: ingestResult });
          } catch (e: any) {
            return error(e.message);
          }
        },
      },
      { names: ["interview_publish_approved"] },
    );
  },
};

export default interviewCommoningPlugin;
