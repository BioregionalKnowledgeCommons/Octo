import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { createHmac } from "node:crypto";
import * as nodePath from "node:path";

const KOI_API = process.env.KOI_API_ENDPOINT || "http://127.0.0.1:8351";
const CRAWL_PROGRESS_POLL_MS = 5000;
const pendingCrawls = new Map<string, PendingCrawlState>();

type PendingCrawlState = {
  jobId: number;
  submittedBy: string;
  url: string;
  instruction?: string;
  chatTarget: string;
  threadId?: number;
  replyToMessageId?: number;
  proposalOverrides: {
    dropped_entity_indices: number[];
    entity_edits: Record<number, { name?: string; description?: string; metadata?: Record<string, unknown> }>;
    dropped_relationship_indices: number[];
  };
  extraRelationships: Array<{ from: number; predicate: string; to: string }>;
  proposal?: any;
  lastProgressKey?: string;
};

function getVaultPath(): string {
  const p = process.env.VAULT_PATH;
  if (!p) throw new Error("VAULT_PATH environment variable must be set");
  return p;
}

function safeVaultPath(relativePath: string): string {
  const vaultRoot = getVaultPath();
  const resolved = nodePath.resolve(vaultRoot, relativePath);
  const normalizedVault = nodePath.resolve(vaultRoot);
  if (!resolved.startsWith(normalizedVault + nodePath.sep) && resolved !== normalizedVault) {
    throw new Error(`Path traversal rejected: "${relativePath}" resolves outside vault root`);
  }
  return resolved;
}

async function koiRequest(path: string, method = "GET", body?: any) {
  const url = `${KOI_API}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KOI API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function getPluginValue(api: OpenClawPluginApi, key: string, envKey?: string): string | undefined {
  const fromPlugin = api.pluginConfig?.[key];
  if (typeof fromPlugin === "string" && fromPlugin.trim()) return fromPlugin.trim();
  const envValue = process.env[envKey || key];
  return envValue && envValue.trim() ? envValue.trim() : undefined;
}

function getApiBase(api: OpenClawPluginApi): string {
  return getPluginValue(api, "apiEndpoint", "KOI_API_ENDPOINT") || KOI_API;
}

async function koiRequestForApi(
  api: OpenClawPluginApi,
  path: string,
  method = "GET",
  body?: any,
  headers?: Record<string, string>,
) {
  const url = `${getApiBase(api)}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KOI API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function normalizeTelegramSenderId(senderId: string | undefined): string {
  const digits = String(senderId || "").match(/\d+/g)?.join("") || "";
  if (!digits) throw new Error("Telegram senderId missing or non-numeric");
  return `tg${digits}`;
}

function buildTelegramAuth(api: OpenClawPluginApi, senderId: string | undefined) {
  const token = getPluginValue(api, "crawlTokenTelegram", "CRAWL_TOKEN_TELEGRAM");
  const secret = getPluginValue(api, "crawlSecretTelegram", "CRAWL_SECRET_TELEGRAM");
  if (!token || !secret) {
    throw new Error("Telegram crawl auth is not configured");
  }
  const identity = normalizeTelegramSenderId(senderId);
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${identity}|${ts}`).digest("hex");
  return {
    submittedBy: `telegram:${identity}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Identity-Claim": `${identity}|${ts}|${signature}`,
    },
  };
}

function buildThreadKeys(channel: string, ids: Array<string | number | undefined | null>, threadId?: number): string[] {
  const out = new Set<string>();
  for (const raw of ids) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    out.add(`${channel}:${value}:${threadId || 0}`);
  }
  return Array.from(out);
}

function storePending(keys: string[], state: PendingCrawlState) {
  for (const key of keys) pendingCrawls.set(key, state);
}

function findPending(keys: string[]): PendingCrawlState | undefined {
  for (const key of keys) {
    const pending = pendingCrawls.get(key);
    if (pending) return pending;
  }
  return undefined;
}

function dropPending(state: PendingCrawlState) {
  for (const [key, value] of Array.from(pendingCrawls.entries())) {
    if (value === state) pendingCrawls.delete(key);
  }
}

function renderProposal(state: PendingCrawlState): string {
  const proposal = state.proposal;
  const entities = Array.isArray(proposal?.entities) ? proposal.entities : [];
  const relationships = Array.isArray(proposal?.relationships) ? proposal.relationships : [];
  const dropped = new Set(state.proposalOverrides.dropped_entity_indices || []);
  const lines = [
    `Crawl proposal for ${state.url}`,
    `Entities:`,
  ];
  for (const entity of entities) {
    const idx = Number(entity.index);
    if (dropped.has(idx)) continue;
    const edit = state.proposalOverrides.entity_edits[idx] || {};
    const name = edit.name || entity.name;
    const description = edit.description || entity.description || "";
    lines.push(`${idx}. ${name} (${entity.type})${description ? ` — ${description}` : ""}`);
  }
  if (relationships.length > 0) {
    lines.push(`Relationships: ${relationships.length}`);
  }
  lines.push("Reply with: approve / cancel / drop N / edit N field: value / rename N new name");
  return lines.join("\n");
}

function applyPendingCommand(state: PendingCrawlState, text: string): string {
  const trimmed = text.trim();
  const dropMatch = trimmed.match(/^drop\s+(\d+)$/i);
  if (dropMatch) {
    const idx = Number(dropMatch[1]);
    if (!state.proposalOverrides.dropped_entity_indices.includes(idx)) {
      state.proposalOverrides.dropped_entity_indices.push(idx);
    }
    return renderProposal(state);
  }
  const renameMatch = trimmed.match(/^rename\s+(\d+)\s+(.+)$/i);
  if (renameMatch) {
    const idx = Number(renameMatch[1]);
    const newName = renameMatch[2].trim();
    state.proposalOverrides.entity_edits[idx] = {
      ...(state.proposalOverrides.entity_edits[idx] || {}),
      name: newName,
    };
    return renderProposal(state);
  }
  const editMatch = trimmed.match(/^edit\s+(\d+)\s+([a-z_]+)\s*:\s*(.+)$/i);
  if (editMatch) {
    const idx = Number(editMatch[1]);
    const field = editMatch[2].toLowerCase();
    const value = editMatch[3].trim();
    if (!["name", "description"].includes(field)) {
      return "Only `name` and `description` are editable in Phase 4.";
    }
    state.proposalOverrides.entity_edits[idx] = {
      ...(state.proposalOverrides.entity_edits[idx] || {}),
      [field]: value,
    };
    return renderProposal(state);
  }
  return "Pending crawl commands: approve / cancel / drop N / edit N field: value / rename N new name";
}

async function sendTelegramThreadMessage(api: OpenClawPluginApi, state: PendingCrawlState, text: string) {
  await api.runtime.channel.telegram.sendMessageTelegram(state.chatTarget, text, {
    messageThreadId: state.threadId,
    replyToMessageId: state.replyToMessageId,
  });
}

async function pollCrawlJob(api: OpenClawPluginApi, headers: Record<string, string>, state: PendingCrawlState) {
  while (true) {
    const data = await koiRequestForApi(api, `/web/crawl-jobs/${state.jobId}`, "GET", undefined, headers);
    const progress = data.progress || {};
    const progressKey = JSON.stringify({
      status: data.status,
      pages: progress.pages_visited,
      entities: progress.entities_so_far,
      cost: data.cost_usd,
    });
    if (progressKey !== state.lastProgressKey && data.status === "running") {
      state.lastProgressKey = progressKey;
      await sendTelegramThreadMessage(
        api,
        state,
        `Crawl in progress: ${progress.pages_visited || 0} pages, ${progress.entities_so_far || 0} entities, $${Number(data.cost_usd || 0).toFixed(4)}`
      );
    }
    if (["done", "failed", "cancelled", "interrupted", "committed", "partially_committed"].includes(String(data.status))) {
      if (data.status !== "done" && data.status !== "partially_committed") {
        dropPending(state);
        await sendTelegramThreadMessage(api, state, `Crawl finished with status ${data.status}${data.error ? `: ${data.error}` : ""}`);
        return;
      }
      state.proposal = data.result;
      await sendTelegramThreadMessage(api, state, renderProposal(state));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, CRAWL_PROGRESS_POLL_MS));
  }
}

async function initializeTelegramCrawl(api: OpenClawPluginApi) {
  const diagnostics = await koiRequestForApi(api, "/diagnostics/config");
  if (diagnostics.agentic_crawl_available !== true) {
    api.logger.info("crawl-site command not registered: agentic crawl unavailable");
    return;
  }

  api.registerCommand({
    name: "crawl-site",
    description: "Start an agentic site crawl in Telegram and manage the resulting proposal in-thread.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (ctx.channel !== "telegram") {
        return { text: "/crawl-site is only wired for Telegram in Phase 4.", isError: true };
      }
      const args = String(ctx.args || "").trim();
      if (!args) {
        return { text: "Usage: /crawl-site <url> [instruction]", isError: true };
      }
      const [url, ...rest] = args.split(/\s+/);
      const instruction = rest.join(" ").trim();
      const auth = buildTelegramAuth(api, ctx.senderId);
      const chatTarget = String(ctx.to || ctx.channelId || ctx.from || ctx.senderId || "");
      if (!chatTarget) {
        return { text: "Unable to determine Telegram chat target for crawl replies.", isError: true };
      }
      const threadId = ctx.messageThreadId;
      const replyToMessageId = undefined;
      const parsed = instruction
        ? await koiRequestForApi(api, "/tools/parse-relate-clause", "POST", { instruction }, auth.headers)
        : { targets: [] };
      const extraRelationships = Array.isArray(parsed.targets)
        ? parsed.targets.map((target: any) => ({
            from: 0,
            predicate: target.predicate_hint || "related_to",
            to: target.label,
          }))
        : [];
      const enqueue = await koiRequestForApi(
        api,
        "/web/crawl-agentic",
        "POST",
        { url, goal: instruction || undefined },
        auth.headers,
      );
      const state: PendingCrawlState = {
        jobId: Number(enqueue.job_id),
        submittedBy: auth.submittedBy,
        url,
        instruction: instruction || undefined,
        chatTarget,
        threadId,
        replyToMessageId,
        proposalOverrides: {
          dropped_entity_indices: [],
          entity_edits: {},
          dropped_relationship_indices: [],
        },
        extraRelationships,
      };
      storePending(
        buildThreadKeys("telegram", [chatTarget, ctx.to, ctx.from, ctx.channelId, ctx.senderId], threadId),
        state,
      );
      void pollCrawlJob(api, auth.headers, state).catch((error) => {
        api.logger.error(`crawl-site polling failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { text: `Started crawl job ${state.jobId} for ${url}. I’ll post progress in this thread.` };
    },
  });

  api.on("message_received", async (event, ctx) => {
    if (!String(ctx.channelId || "").includes("telegram")) return;
    const metadata = (event.metadata || {}) as Record<string, unknown>;
    const threadId = Number(
      metadata.messageThreadId ||
        metadata.message_thread_id ||
        metadata.threadId ||
        0,
    ) || undefined;
    const replyToMessageId = Number(metadata.messageId || metadata.message_id || 0) || undefined;
    const keys = buildThreadKeys("telegram", [ctx.conversationId, ctx.channelId, metadata.chatId, event.from], threadId);
    const pending = findPending(keys);
    if (!pending) return;
    pending.replyToMessageId = replyToMessageId;
    const text = String(event.content || "").trim();
    if (!text) return;
    const auth = buildTelegramAuth(api, event.from);
    if (/^cancel$/i.test(text)) {
      dropPending(pending);
      await sendTelegramThreadMessage(api, pending, "Cancelled pending crawl proposal.");
      return;
    }
    if (/^approve$/i.test(text)) {
      const commitBody = {
        proposal_overrides: pending.proposalOverrides,
        extra_relationships: pending.extraRelationships,
      };
      const result = await koiRequestForApi(
        api,
        `/web/crawl-jobs/${pending.jobId}/commit`,
        "POST",
        commitBody,
        auth.headers,
      );
      dropPending(pending);
      await sendTelegramThreadMessage(
        api,
        pending,
        `Commit ${result.status}: committed=${(result.committed || []).length}, skipped=${(result.skipped || []).length}, errors=${(result.errors || []).length}`,
      );
      return;
    }
    const response = applyPendingCommand(pending, text);
    await sendTelegramThreadMessage(api, pending, response);
  });

  api.logger.info("Registered Telegram crawl-site command + reply hook");
}

async function resolveToUri(nameOrUri: string): Promise<string> {
  // If it already looks like a URI, return as-is
  if (nameOrUri.startsWith("orn:")) return nameOrUri;
  // Otherwise resolve the name to a URI
  const data = await koiRequest("/entity/resolve", "POST", { label: nameOrUri });
  const candidates = data.candidates || [];
  if (candidates.length > 0 && candidates[0].confidence >= 0.5) {
    return candidates[0].uri;
  }
  throw new Error(`Could not resolve "${nameOrUri}" to a known entity`);
}

const bioregionalKoiPlugin = {
  id: "bioregional-koi",
  name: "Bioregional KOI",
  description: "Knowledge graph tools for bioregional knowledge commoning",
  register(api: OpenClawPluginApi) {
    void initializeTelegramCrawl(api).catch((error) => {
      api.logger.error(`Failed to initialize Telegram crawl flow: ${error instanceof Error ? error.message : String(error)}`);
    });

    // resolve_entity — disambiguate a name to a canonical entity
    api.registerTool(
      {
        name: "resolve_entity",
        description:
          "Resolve an entity name to its canonical form in the knowledge graph. Use this when someone mentions a person, organization, project, or concept by name. Returns the best match with type, URI, and confidence.",
        parameters: {
          type: "object",
          properties: {
            label: { type: "string", description: "The entity name or label to resolve (e.g. 'Bill', 'r3.0', 'pattern mining')" },
            type_hint: { type: "string", description: "Optional type hint: Person, Organization, Project, Concept, Location, Meeting" },
          },
          required: ["label"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const label = params.label as string;
          const type_hint = params.type_hint as string | undefined;
          const data = await koiRequest("/entity/resolve", "POST", {
            label,
            type_hint: type_hint || undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["resolve_entity"] },
    );

    // get_entity_neighborhood — see relationships around an entity
    api.registerTool(
      {
        name: "get_entity_neighborhood",
        description:
          "Get the neighborhood of an entity in the knowledge graph — its relationships, affiliated organizations, projects, and connected people. Use when asked 'who works with X?' or 'what is Y involved in?'",
        parameters: {
          type: "object",
          properties: {
            entity_uri: { type: "string", description: "The entity URI or name (e.g. 'bill-baue', 'r3.0')" },
          },
          required: ["entity_uri"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const input = params.entity_uri as string;
          const uri = await resolveToUri(input);
          const data = await koiRequest(`/relationships/${encodeURIComponent(uri)}`);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["get_entity_neighborhood"] },
    );

    // get_entity_documents — find documents mentioning an entity
    api.registerTool(
      {
        name: "get_entity_documents",
        description:
          "Find all documents that mention a specific entity. Use when asked 'what documents mention X?' or 'where is Y referenced?'",
        parameters: {
          type: "object",
          properties: {
            entity_uri: { type: "string", description: "The entity URI or name" },
          },
          required: ["entity_uri"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const input = params.entity_uri as string;
          const uri = await resolveToUri(input);
          const data = await koiRequest(`/entity/${encodeURIComponent(uri)}/mentioned-in`);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["get_entity_documents"] },
    );

    // search — semantic search across the knowledge base
    api.registerTool(
      {
        name: "koi_search",
        description:
          "Search the bioregional knowledge graph using semantic similarity. Returns entities and documents matching the query. Use for broad knowledge questions.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
            type_filter: { type: "string", description: "Optional: filter by entity type (Person, Organization, Project, Concept)" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const query = params.query as string;
          const type_filter = params.type_filter as string | undefined;
          const limit = (params.limit as number) || 10;
          const qs = new URLSearchParams({ query, limit: String(limit) });
          if (type_filter) qs.set("type_filter", type_filter);
          const data = await koiRequest(`/entity-search?${qs}`);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["koi_search"] },
    );

    // knowledge_search — semantic search over indexed documents (RAG)
    api.registerTool(
      {
        name: "knowledge_search",
        description:
          "Search indexed documents using semantic similarity (RAG). Searches over koi_memories — GitHub code files, docs, markdown, configs — using OpenAI embeddings. Returns document-level results AND chunk-level results (individual functions, classes, or text sections). Use this for questions about codebase content, documentation, architecture, or any knowledge in the indexed repositories. For entity-level search, use koi_search instead.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query — natural language question or keywords" },
            source: { type: "string", description: "Optional: filter by source ('github', 'vault', 'email')" },
            limit: { type: "number", description: "Max results (default 10)" },
            include_chunks: { type: "boolean", description: "Include chunk-level results — individual functions/classes for code, text sections for docs (default true)" },
          },
          required: ["query"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const body: Record<string, unknown> = {
            query: params.query,
            limit: (params.limit as number) || 10,
            include_chunks: params.include_chunks !== false,  // default true
          };
          if (params.source) body.source = params.source;
          const data = await koiRequest("/search", "POST", body);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["knowledge_search"] },
    );

    // vault_read_note — read a markdown note from the vault
    api.registerTool(
      {
        name: "vault_read_note",
        description:
          "Read a structured entity note from the bioregional knowledge vault. Notes are in folders: People/, Organizations/, Projects/, Concepts/, Bioregions/",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path within the vault (e.g. 'People/Bill Baue.md')" },
          },
          required: ["path"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const notePath = params.path as string;
          const fs = await import("node:fs/promises");
          try {
            const fullPath = safeVaultPath(notePath);
            const content = await fs.readFile(fullPath, "utf-8");
            return { content: [{ type: "text", text: content }] };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Error reading ${notePath}: ${e.message}` }], isError: true };
          }
        },
      },
      { names: ["vault_read_note"] },
    );

    // vault_write_note — create/update a note in the vault
    api.registerTool(
      {
        name: "vault_write_note",
        description:
          "Create or update an entity note in the bioregional knowledge vault. Use when learning about new entities. Include proper frontmatter with @type.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path (e.g. 'People/New Person.md')" },
            content: { type: "string", description: "Full markdown content including YAML frontmatter" },
          },
          required: ["path", "content"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const notePath = params.path as string;
          const content = params.content as string;
          const fs = await import("node:fs/promises");
          const fullPath = safeVaultPath(notePath);
          const dir = nodePath.dirname(fullPath);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(fullPath, content, "utf-8");
          return { content: [{ type: "text", text: `Written: ${notePath}` }] };
        },
      },
      { names: ["vault_write_note"] },
    );

    // vault_list_notes — list notes in a vault folder
    api.registerTool(
      {
        name: "vault_list_notes",
        description:
          "List entity notes in a vault folder. Folders: People, Organizations, Projects, Concepts, Bioregions",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Folder name (e.g. 'People', 'Organizations')" },
          },
          required: ["folder"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const folder = params.folder as string;
          const fs = await import("node:fs/promises");
          try {
            const fullPath = safeVaultPath(folder);
            const files = await fs.readdir(fullPath);
            const mdFiles = files.filter((f: string) => f.endsWith(".md"));
            return { content: [{ type: "text", text: mdFiles.join("\n") }] };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Error listing ${folder}: ${e.message}` }], isError: true };
          }
        },
      },
      { names: ["vault_list_notes"] },
    );

    // preview_url — fetch and preview a URL for evaluation
    api.registerTool(
      {
        name: "preview_url",
        description:
          "Fetch and preview a URL someone shared. Returns title, content summary, detected entities, and safety check. Use when someone shares a URL. Does NOT ingest — just previews so you can evaluate relevance.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to preview" },
            submitted_by: { type: "string", description: "Username of the person who shared the URL" },
            submitted_via: { type: "string", description: "Channel: telegram, discord, or api" },
          },
          required: ["url"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const url = params.url as string;
          const submitted_by = params.submitted_by as string | undefined;
          const submitted_via = (params.submitted_via as string) || "api";
          const data = await koiRequest("/web/preview", "POST", {
            url,
            submitted_by,
            submitted_via,
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["preview_url"] },
    );

    // process_url — extract entities/relationships from previewed URL using LLM
    api.registerTool(
      {
        name: "process_url",
        description:
          "Extract entities, relationships, and descriptions from a previewed URL using server-side LLM. Call AFTER preview_url and BEFORE ingest_url. Returns structured extraction with descriptions that make vault notes richer.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to process (must have been previewed first)" },
            hint_entities: {
              type: "array",
              description: "Optional: entity names you already spotted to help the LLM match",
              items: { type: "string" },
            },
          },
          required: ["url"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const url = params.url as string;
          const hint_entities = (params.hint_entities as string[]) || [];
          const data = await koiRequest("/web/process", "POST", {
            url,
            hint_entities,
            auto_ingest: false,
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["process_url"] },
    );

    // ingest_url — ingest a previously previewed URL
    api.registerTool(
      {
        name: "ingest_url",
        description:
          "Ingest a previously previewed URL into the knowledge graph. Call AFTER preview_url and your evaluation. Pass the entities and relationships you identified from the preview.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to ingest (must have been previewed first)" },
            entities: {
              type: "array",
              description: "Entities to resolve and link to this URL",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string", description: "Person, Organization, Project, Concept, Location, Bioregion, Practice, etc." },
                  context: { type: "string", description: "Brief context for how this entity relates" },
                  confidence: { type: "number", description: "Optional confidence score 0-1 (null treated as 0.0 by quality gates)" },
                },
                required: ["name", "type"],
              },
            },
            relationships: {
              type: "array",
              description: "Relationships between entities",
              items: {
                type: "object",
                properties: {
                  subject: { type: "string" },
                  predicate: { type: "string" },
                  object: { type: "string" },
                },
                required: ["subject", "predicate", "object"],
              },
            },
          },
          required: ["url"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const url = params.url as string;
          const entities = (params.entities as any[]) || [];
          const relationships = (params.relationships as any[]) || [];
          const data = await koiRequest("/web/ingest", "POST", {
            url,
            entities,
            relationships,
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["ingest_url"] },
    );

    // github_scan — trigger a GitHub sensor scan or check status
    api.registerTool(
      {
        name: "github_scan",
        description:
          "Trigger a GitHub repository scan or check sensor status. Use to index the Octo codebase for self-knowledge. Without action, returns current status.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "Action: 'scan' to trigger scan, 'status' to check status (default: status)",
            },
            repo_name: {
              type: "string",
              description: "Optional: specific repo to scan (e.g. 'DarrenZal/Octo')",
            },
          },
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const action = (params.action as string) || "status";
          if (action === "scan") {
            const repo_name = params.repo_name as string | undefined;
            const qs = repo_name ? `?repo_name=${encodeURIComponent(repo_name)}` : "";
            const data = await koiRequest(`/github/scan${qs}`, "POST");
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
          }
          const data = await koiRequest("/github/status");
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["github_scan"] },
    );

    // monitor_url — add/remove/check web source monitoring
    api.registerTool(
      {
        name: "monitor_url",
        description:
          "Manage web source monitoring. Add URLs to be periodically checked for content changes, which triggers re-extraction of entities and relationships. Use to keep the knowledge graph up to date with external sources.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "Action: 'add' to start monitoring, 'remove' to stop, 'status' to check (default: status)",
            },
            url: {
              type: "string",
              description: "URL to add/remove from monitoring",
            },
            title: {
              type: "string",
              description: "Optional title for the source (used when adding)",
            },
          },
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const action = (params.action as string) || "status";
          if (action === "add") {
            const data = await koiRequest("/web/monitor/add", "POST", {
              url: params.url,
              title: params.title || "",
            });
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
          }
          if (action === "remove") {
            const data = await koiRequest("/web/monitor/remove", "POST", {
              url: params.url,
            });
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
          }
          const data = await koiRequest("/web/monitor/status");
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["monitor_url"] },
    );

    // code_query — run Cypher queries against the code graph
    api.registerTool(
      {
        name: "code_query",
        description:
          "Query the code knowledge graph using Cypher. The graph contains Functions, Classes, Modules, Files, Imports, and Interfaces with CALLS, CONTAINS, BELONGS_TO relationships. Example: MATCH (f:Function) WHERE f.name = 'resolve_entity' RETURN f.file_path, f.signature",
        parameters: {
          type: "object",
          properties: {
            cypher: {
              type: "string",
              description: "Cypher query to execute against the regen_graph code knowledge graph",
            },
          },
          required: ["cypher"],
        },
        async execute(_id: string, params: Record<string, unknown>) {
          const cypher = params.cypher as string;
          const data = await koiRequest("/code/query", "POST", { cypher });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["code_query"] },
    );

    // federation_status — query KOI-net federation state
    api.registerTool(
      {
        name: "federation_status",
        description:
          "Get KOI-net federation status: node identity, connected peers, event queue size, and protocol policy (strict mode, signed envelopes, etc.). Use when asked about federation state, connected nodes, or KOI-net health.",
        parameters: {
          type: "object",
          properties: {},
        },
        async execute(_id: string, _params: Record<string, unknown>) {
          const data = await koiRequest("/koi-net/health");
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        },
      },
      { names: ["federation_status"] },
    );
  },
};

export default bioregionalKoiPlugin;
