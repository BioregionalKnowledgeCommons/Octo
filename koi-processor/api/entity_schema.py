#!/usr/bin/env python3
"""
Entity Schema Loader

Loads entity type configurations from vault Ontology/ schemas.
Provides schema-driven entity resolution instead of hardcoded type mappings.

Key features:
- Loads schemas from vault Ontology/ folder
- Phonetic matching is opt-in (default: false)
- Per-type stopwords for phonetic matching
- Thread-safe reload support
- Fallback to defaults if vault unavailable
"""

import yaml
import re
import os
import logging
import threading
import hashlib
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, Optional, Set, List

logger = logging.getLogger(__name__)

# Regex for proper frontmatter parsing (anchored at file start, handles CRLF)
FRONTMATTER_RE = re.compile(r'\A\ufeff?---\r?\n(.*?)\r?\n---', re.DOTALL)  # \ufeff = BOM

# Fallback folder mapping for known types (avoids f"{label}s" brittleness)
FOLDER_FALLBACKS = {
    'Person': 'People',
    'Organization': 'Organizations',
    'Project': 'Projects',
    'Location': 'Locations',
    'Concept': 'Concepts',
    'Meeting': 'Meetings',
    'Practice': 'Practices',
    'Pattern': 'Patterns',
    'CaseStudy': 'CaseStudies',
    'Bioregion': 'Bioregions',
    'Protocol': 'Protocols',
    'Playbook': 'Playbooks',
    'Question': 'Questions',
    'Claim': 'Claims',
    'Evidence': 'Evidence',
}

# Global default stopwords (union with per-type)
GLOBAL_PHONETIC_STOPWORDS = {'the', 'a', 'an'}

# Irish/Celtic and other name normalizations for phonetic matching
# Maps spelling variants to phonetically-equivalent standard forms
# This fixes cases where names sound identical but have different Metaphone codes
PHONETIC_NAME_NORMALIZATIONS = {
    # Irish names where spelling doesn't match English phonetic rules
    'sean': 'shawn',        # Irish: Se = Sh sound
    'siobhan': 'shivon',    # Irish: Sio = Sh sound
    'niamh': 'neeve',       # Irish: mh = v sound
    'caoimhe': 'keeva',     # Irish
    'cian': 'kian',         # Irish: C = K
    'ciara': 'kiara',       # Irish: C = K
    'aisling': 'ashling',   # Irish: Ais = Ash
    'aoife': 'eefa',        # Irish
    'saoirse': 'seersha',   # Irish
    'eoin': 'owen',         # Irish variant of Owen
    'padraig': 'patrick',   # Irish variant
    'tadhg': 'tige',        # Irish
    # Scottish
    'iain': 'ian',          # Scottish variant
    # Welsh
    'rhys': 'reese',        # Welsh
    'siân': 'shan',         # Welsh
}


@dataclass
class EntityTypeConfig:
    """Configuration for a single entity type loaded from schema."""
    type_key: str          # Explicit from frontmatter, or raw slug (not .title())
    label: str             # Human-readable name
    folder: str            # REQUIRED or use fallback
    phonetic_matching: bool = False
    phonetic_stopwords: Set[str] = field(default_factory=set)  # Per-type stopwords
    type_aliases: List[str] = field(default_factory=list)  # e.g., ["project", "Project"]
    min_context_people: int = 2
    similarity_threshold: float = 0.85
    semantic_threshold: float = 0.92
    require_token_overlap: bool = True


# Default fallback schemas - phonetic ONLY for Person (consistent with opt-in policy)
DEFAULT_SCHEMAS = {
    'Person': EntityTypeConfig(
        type_key='Person',
        label='Person',
        folder='People',
        phonetic_matching=True,
        phonetic_stopwords={'dr', 'mr', 'mrs', 'ms', 'prof'},
        min_context_people=1,
        similarity_threshold=0.92,
        require_token_overlap=False
    ),
    'Organization': EntityTypeConfig(
        type_key='Organization',
        label='Organization',
        folder='Organizations',
        phonetic_matching=False,  # Opt-in, not default
        similarity_threshold=0.85
    ),
    'Project': EntityTypeConfig(
        type_key='Project',
        label='Project',
        folder='Projects',
        phonetic_matching=False,  # Opt-in, not default
        similarity_threshold=0.85
    ),
    'Location': EntityTypeConfig(
        type_key='Location',
        label='Location',
        folder='Locations',
        phonetic_matching=False,
        similarity_threshold=0.90,
        require_token_overlap=True
    ),
    'Concept': EntityTypeConfig(
        type_key='Concept',
        label='Concept',
        folder='Concepts',
        phonetic_matching=False,
        similarity_threshold=0.75,
        semantic_threshold=0.88,
        require_token_overlap=False
    ),
    'Meeting': EntityTypeConfig(
        type_key='Meeting',
        label='Meeting',
        folder='Meetings',
        phonetic_matching=False,
        min_context_people=1,
        similarity_threshold=0.90
    ),
    'Practice': EntityTypeConfig(
        type_key='Practice',
        label='Practice',
        folder='Practices',
        phonetic_matching=False,
        similarity_threshold=0.80,
        semantic_threshold=0.90,
        require_token_overlap=True,
    ),
    'Pattern': EntityTypeConfig(
        type_key='Pattern',
        label='Pattern',
        folder='Patterns',
        phonetic_matching=False,
        similarity_threshold=0.80,
        semantic_threshold=0.90,
        require_token_overlap=True,
    ),
    'CaseStudy': EntityTypeConfig(
        type_key='CaseStudy',
        label='Case Study',
        folder='CaseStudies',
        phonetic_matching=False,
        similarity_threshold=0.85,
        semantic_threshold=0.92,
        require_token_overlap=True,
    ),
    'Bioregion': EntityTypeConfig(
        type_key='Bioregion',
        label='Bioregion',
        folder='Bioregions',
        phonetic_matching=False,
        similarity_threshold=0.85,
        semantic_threshold=0.92,
        require_token_overlap=True,
    ),
    'Protocol': EntityTypeConfig(
        type_key='Protocol',
        label='Protocol',
        folder='Protocols',
        phonetic_matching=False,
        similarity_threshold=0.85,
        semantic_threshold=0.92,
        require_token_overlap=True,
    ),
    'Playbook': EntityTypeConfig(
        type_key='Playbook',
        label='Playbook',
        folder='Playbooks',
        phonetic_matching=False,
        similarity_threshold=0.85,
        semantic_threshold=0.92,
        require_token_overlap=True,
    ),
    'Question': EntityTypeConfig(
        type_key='Question',
        label='Question',
        folder='Questions',
        phonetic_matching=False,
        similarity_threshold=0.75,
        semantic_threshold=0.88,
        require_token_overlap=False,
    ),
    'Claim': EntityTypeConfig(
        type_key='Claim',
        label='Claim',
        folder='Claims',
        phonetic_matching=False,
        similarity_threshold=0.75,
        semantic_threshold=0.88,
        require_token_overlap=False,
    ),
    'Evidence': EntityTypeConfig(
        type_key='Evidence',
        label='Evidence',
        folder='Evidence',
        phonetic_matching=False,
        similarity_threshold=0.80,
        semantic_threshold=0.90,
        require_token_overlap=True,
    ),
}

# Safe default schema for unknown types (never returns None)
UNKNOWN_TYPE_SCHEMA = EntityTypeConfig(
    type_key='_unknown',
    label='Unknown',
    folder='Misc',
    phonetic_matching=False,
    phonetic_stopwords=set(),
    min_context_people=2,
    similarity_threshold=0.90,  # Higher = stricter
    semantic_threshold=0.95,
    require_token_overlap=True,
)


def normalize_for_phonetics(token: str) -> str:
    """
    Normalize a token for phonetic matching.

    Handles Irish/Celtic names where spelling doesn't match English phonetic rules.
    E.g., "Sean" → "Shawn" (both sound the same but have different Metaphone codes)
    """
    normalized = token.casefold()
    return PHONETIC_NAME_NORMALIZATIONS.get(normalized, normalized)


def get_first_significant_token(text: str, stopwords: Set[str] = None) -> str:
    """
    Get first non-stopword token for phonetic matching.
    Union of per-type stopwords + global stopwords. All casefolded.
    Also normalizes Irish/Celtic names to standard phonetic forms.
    """
    effective_stopwords = GLOBAL_PHONETIC_STOPWORDS.copy()
    if stopwords:
        effective_stopwords.update(sw.casefold() for sw in stopwords)
    tokens = text.casefold().split()  # casefold > lower for i18n
    for token in tokens:
        if token not in effective_stopwords:
            # Normalize for phonetics (handles Irish names like Sean → Shawn)
            return normalize_for_phonetics(token)
    return normalize_for_phonetics(tokens[0]) if tokens else ''


def parse_frontmatter(content: str) -> Optional[dict]:
    """Parse YAML frontmatter using anchored regex (not brittle index)."""
    match = FRONTMATTER_RE.match(content)
    if match:
        try:
            return yaml.safe_load(match.group(1))
        except yaml.YAMLError as e:
            logger.warning(f"Failed to parse YAML frontmatter: {e}")
            return None
    return None


def load_entity_schemas(vault_path: Optional[str] = None) -> Dict[str, EntityTypeConfig]:
    """
    Load entity type configs from vault Ontology/ folder.

    Uses explicit type_key from frontmatter (not derived via .title()).
    Falls back to defaults if vault not available.

    Args:
        vault_path: Path to vault root. Can also be set via ENTITY_SCHEMA_PATH env var.

    Returns:
        Dict mapping type_key to EntityTypeConfig
    """
    schema_path = os.environ.get('ENTITY_SCHEMA_PATH') or vault_path
    if not schema_path:
        logger.warning("No vault path configured, using default schemas")
        return DEFAULT_SCHEMAS.copy()

    ontology_path = Path(schema_path) / "Ontology"
    if not ontology_path.exists():
        logger.warning(f"Ontology path {ontology_path} not found, using defaults")
        return DEFAULT_SCHEMAS.copy()

    schemas = {}
    seen_folders = {}

    for schema_file in ontology_path.glob("schema-*.md"):
        try:
            content = schema_file.read_text(encoding='utf-8')
            frontmatter = parse_frontmatter(content)
            if not frontmatter:
                logger.warning(f"No frontmatter in {schema_file}, skipping")
                continue

            # Get type_key: prefer explicit, else use label, else raw slug
            raw_slug = schema_file.stem.replace('schema-', '')  # e.g., "eco-credit"
            resolution = frontmatter.get('resolution', {})
            type_key = resolution.get('type_key') or frontmatter.get('label') or raw_slug
            label = frontmatter.get('label', type_key)

            # Folder: REQUIRED in resolution, else use fallback map, else error
            folder = resolution.get('folder')
            if not folder:
                folder = FOLDER_FALLBACKS.get(type_key)
            if not folder:
                logger.error(f"Schema {schema_file}: no resolution.folder and no fallback for '{type_key}'")
                continue

            # Detect folder collisions
            if folder in seen_folders:
                logger.error(f"Folder collision: {folder} used by both "
                           f"{seen_folders[folder]} and {type_key}")
                continue
            seen_folders[folder] = type_key

            # Per-type stopwords (casefold on load)
            stopwords_list = resolution.get('phonetic_stopwords', [])
            stopwords = {sw.casefold() for sw in stopwords_list} if stopwords_list else set()

            # Type aliases for normalization (e.g., DB has "project" or "Project")
            aliases = resolution.get('type_aliases', [])

            schemas[type_key] = EntityTypeConfig(
                type_key=type_key,
                label=label,
                folder=folder,
                phonetic_matching=resolution.get('phonetic_matching', False),
                phonetic_stopwords=stopwords,
                type_aliases=aliases,
                min_context_people=resolution.get('min_context_people', 2),
                similarity_threshold=resolution.get('similarity_threshold', 0.85),
                semantic_threshold=resolution.get('semantic_threshold', 0.92),
                require_token_overlap=resolution.get('require_token_overlap', True),
            )
            logger.info(f"Loaded schema: {type_key} → {folder} "
                       f"(phonetic={resolution.get('phonetic_matching', False)})")

        except Exception as e:
            logger.error(f"Failed to load schema {schema_file}: {e}")

    if not schemas:
        logger.warning("No schemas loaded from vault, using defaults")
        return DEFAULT_SCHEMAS.copy()

    # Merge with defaults for any missing types
    for type_key, default_config in DEFAULT_SCHEMAS.items():
        if type_key not in schemas:
            logger.info(f"Using default schema for {type_key} (not found in vault)")
            schemas[type_key] = default_config

    return schemas


# Thread-safe schema registry with atomic swap
_schema_lock = threading.Lock()
_entity_schemas: Dict[str, EntityTypeConfig] = {}
_schema_version: Optional[str] = None


def compute_schema_version(schemas: Dict[str, EntityTypeConfig]) -> str:
    """Compute etag from schema content for cache invalidation."""
    content = ''.join(
        f"{s.type_key}:{s.folder}:{s.phonetic_matching}:{s.similarity_threshold}"
        for s in sorted(schemas.values(), key=lambda x: x.type_key)
    )
    return hashlib.md5(content.encode()).hexdigest()[:8]


def get_entity_schemas() -> Dict[str, EntityTypeConfig]:
    """Get loaded schemas. Loads from vault on first call."""
    global _entity_schemas, _schema_version
    with _schema_lock:
        if not _entity_schemas:
            # Try to load from default vault path
            default_vault = os.environ.get('VAULT_PATH', os.path.expanduser('~/Documents/Notes'))
            logger.info(f"Loading entity schemas from: {default_vault}")
            _entity_schemas = load_entity_schemas(default_vault)
            _schema_version = compute_schema_version(_entity_schemas)
            logger.info(f"Loaded {len(_entity_schemas)} entity schemas (version: {_schema_version})")
            # Log individual schema details for debugging
            for name, schema in sorted(_entity_schemas.items()):
                phonetic = getattr(schema, 'phonetic_matching', False)
                logger.info(f"  {name}: phonetic_matching={phonetic}, folder={getattr(schema, 'folder', 'N/A')}")
        return _entity_schemas.copy()  # Return copy to prevent mutation


def get_schema_version() -> str:
    """Get current schema version hash."""
    global _schema_version
    if _schema_version is None:
        get_entity_schemas()  # Trigger load
    return _schema_version or 'unknown'


def reload_entity_schemas(vault_path: Optional[str] = None) -> Dict[str, EntityTypeConfig]:
    """Reload schemas atomically (thread-safe)."""
    global _entity_schemas, _schema_version
    new_schemas = load_entity_schemas(vault_path)  # Load outside lock
    new_version = compute_schema_version(new_schemas)
    with _schema_lock:
        _entity_schemas = new_schemas  # Atomic swap
        _schema_version = new_version
    logger.info(f"Reloaded {len(new_schemas)} entity schemas (version: {new_version})")
    return new_schemas


def get_schema_for_type(type_hint: str) -> EntityTypeConfig:
    """
    Get schema for type. Returns safe default for unknown types (never None).

    Args:
        type_hint: Entity type string (e.g., "Person", "person", "Project")

    Returns:
        EntityTypeConfig for the type, or UNKNOWN_TYPE_SCHEMA if not found
    """
    schemas = get_entity_schemas()

    # Try exact match first
    if type_hint in schemas:
        return schemas[type_hint]

    # Try case-insensitive match
    type_hint_lower = type_hint.casefold()
    for key, schema in schemas.items():
        if key.casefold() == type_hint_lower:
            return schema
        # Check aliases
        if any(a.casefold() == type_hint_lower for a in schema.type_aliases):
            return schema

    logger.warning(f"Unknown entity type '{type_hint}', using safe default")
    return UNKNOWN_TYPE_SCHEMA


def get_all_entity_types() -> List[str]:
    """Get list of all known entity type keys."""
    return list(get_entity_schemas().keys())


def type_to_folder(type_key: str) -> str:
    """Map entity type to vault folder."""
    schema = get_schema_for_type(type_key)
    return schema.folder


def folder_to_type(folder: str) -> Optional[str]:
    """Map vault folder to entity type."""
    schemas = get_entity_schemas()
    for type_key, schema in schemas.items():
        if schema.folder == folder or schema.folder.rstrip('s') == folder.rstrip('s'):
            return type_key
    return None


def get_phonetic_enabled_types() -> List[str]:
    """Get list of entity types with phonetic matching enabled."""
    schemas = get_entity_schemas()
    return [type_key for type_key, schema in schemas.items() if schema.phonetic_matching]
