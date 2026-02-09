-- Migration 038: BKC Ontology Predicates
-- Date: 2026-02-08
-- Purpose: Add knowledge commoning, discourse graph, SKOS, and hyphal predicates

INSERT INTO allowed_predicates (predicate, description, subject_types, object_types) VALUES
  -- Phase A: Knowledge Commoning
  ('aggregates_into', 'Practice aggregates into pattern', ARRAY['Practice'], ARRAY['Pattern']),
  ('suggests', 'Pattern suggests practice (not inverse of aggregates_into)', ARRAY['Pattern'], ARRAY['Practice']),
  ('documents', 'Case study documents practice/pattern', ARRAY['CaseStudy'], ARRAY['Practice', 'Pattern']),
  ('practiced_in', 'Practice is enacted in a bioregion', ARRAY['Practice'], ARRAY['Bioregion', 'Location']),
  -- Phase B: Discourse Graph
  ('supports', 'Evidence/claim supports claim', ARRAY['Evidence', 'Claim'], ARRAY['Claim']),
  ('opposes', 'Evidence/claim opposes claim', ARRAY['Evidence', 'Claim'], ARRAY['Claim']),
  ('informs', 'Informs question or protocol', ARRAY['Evidence', 'Claim'], ARRAY['Question', 'Protocol']),
  ('generates', 'Generates evidence or questions', ARRAY['Playbook', 'Question'], ARRAY['Evidence', 'Question']),
  ('implemented_by', 'Protocol implemented by playbook', ARRAY['Protocol'], ARRAY['Playbook']),
  ('synthesizes', 'Claim synthesizes evidence', ARRAY['Claim'], ARRAY['Evidence']),
  ('about', 'Node is about a domain entity (dcterms:subject)', ARRAY['Evidence', 'Claim', 'Question', 'Protocol', 'Playbook'], ARRAY['Practice', 'Pattern', 'CaseStudy', 'Concept', 'Project', 'Bioregion']),
  -- Phase C: SKOS + Hyphal
  ('broader', 'SKOS broader concept', ARRAY['Concept', 'Bioregion'], ARRAY['Concept', 'Bioregion']),
  ('narrower', 'SKOS narrower concept', ARRAY['Concept', 'Bioregion'], ARRAY['Concept', 'Bioregion']),
  ('related_to', 'SKOS related (cross-reference)', ARRAY['Person', 'Organization', 'Project', 'Concept', 'Practice', 'Pattern', 'Protocol', 'Bioregion', 'CaseStudy', 'Question', 'Claim', 'Evidence'], ARRAY['Person', 'Organization', 'Project', 'Concept', 'Practice', 'Pattern', 'Protocol', 'Bioregion', 'CaseStudy', 'Question', 'Claim', 'Evidence']),
  ('forked_from', 'Hyphal: branched from', ARRAY['Project', 'Concept', 'Practice'], ARRAY['Project', 'Concept', 'Practice']),
  ('builds_on', 'Hyphal: develops from', ARRAY['Project', 'Concept', 'Practice'], ARRAY['Project', 'Concept', 'Practice']),
  ('inspired_by', 'Hyphal: conceptual inspiration', ARRAY['Project', 'Concept', 'Practice'], ARRAY['Project', 'Concept', 'Practice'])
ON CONFLICT (predicate) DO NOTHING;

-- Note: documented_by and implements are NOT separate predicates.
-- They are parser aliases that create 'documents' and 'implemented_by'
-- relationships with swapped subject/object direction.
