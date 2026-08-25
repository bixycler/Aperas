/**
 * Aperas Phase 0: TerminusDB Substrate Schema Definitions
 * 
 * Defines the canonical JSON-LD schema for the Aperas knowledge engine operating over TerminusDB.
 * Implements the core architecture specified in Aperas-design.md:
 * - Fluid Core (Apeiron): Continuous, unconditioned semantic field stored as coarse AST nodes and character offset ranges.
 * - Peras Interface: Typed boundary models reified on demand.
 */

export interface DocumentNodeSchema {
  "@type": "Class";
  "@id": "DocumentNode";
  "@key": {
    "@type": "Lexical";
    "@fields": ["docId"];
  };
  docId: "xsd:string";
  title: "xsd:string";
  rawMarkdown: "xsd:string";
  createdAt: "xsd:string";
}

export interface BlockNodeSchema {
  "@type": "Class";
  "@id": "BlockNode";
  "@key": {
    "@type": "Lexical";
    "@fields": ["blockId"];
  };
  blockId: "xsd:string";
  docId: "xsd:string";
  nodeType: "xsd:string"; // paragraph, header, listItem, etc.
  content: "xsd:string";
  startOffset: "xsd:integer";
  endOffset: "xsd:integer";
  parentBlockId?: {
    "@type": "Optional";
    "@class": "xsd:string";
  };
}

export interface SpanNodeSchema {
  "@type": "Class";
  "@id": "SpanNode";
  "@key": {
    "@type": "Lexical";
    "@fields": ["spanId"];
  };
  spanId: "xsd:string";
  blockId: "xsd:string";
  text: "xsd:string";
  startOffset: "xsd:integer";
  endOffset: "xsd:integer";
  predicate?: {
    "@type": "Optional";
    "@class": "xsd:string";
  };
}

export interface TripleAssertionSchema {
  "@type": "Class";
  "@id": "TripleAssertion";
  "@key": {
    "@type": "Random";
  };
  subjectId: "xsd:string";
  predicate: "xsd:string"; // e.g. "impacts", "verifies", "derived_from", "affects"
  objectId: "xsd:string";
  provenance: "xsd:string";
  timestamp: "xsd:string";
}

export interface ArtifactNodeSchema {
  "@type": "Class";
  "@id": "ArtifactNode";
  "@key": {
    "@type": "Lexical";
    "@fields": ["path"];
  };
  path: "xsd:string";
  contentHash: "xsd:string";
  lastTrackedAt: "xsd:string";
  ingestedHash?: {
    "@type": "Optional";
    "@class": "xsd:string";
  };
  lastIngestedAt?: {
    "@type": "Optional";
    "@class": "xsd:string";
  };
  docId?: {
    "@type": "Optional";
    "@class": "xsd:string";
  };
}

/**
 * Returns the full JSON-LD schema array to be committed to TerminusDB schema context.
 *
 * Includes the `@context` document explicitly: schema writes go through `full_replace`
 * (see client.ts) to stay idempotent across re-runs, and a full_replace requires the
 * submitted set to be a complete, valid schema graph — omitting `@context` here made the
 * server reject the whole replacement with "No context found in submitted schema".
 */
export function getAperasSchemaObjects(): any[] {
  return [
    {
      "@type": "@context",
      "@base": "terminusdb:///data/",
      "@schema": "terminusdb:///schema#"
    },
    {
      "@type": "Class",
      "@id": "DocumentNode",
      "@key": {
        "@type": "Lexical",
        "@fields": ["docId"]
      },
      "docId": "xsd:string",
      "title": "xsd:string",
      "rawMarkdown": "xsd:string",
      "createdAt": "xsd:string"
    },
    {
      "@type": "Class",
      "@id": "BlockNode",
      "@key": {
        "@type": "Lexical",
        "@fields": ["blockId"]
      },
      "blockId": "xsd:string",
      "docId": "xsd:string",
      "nodeType": "xsd:string",
      "content": "xsd:string",
      "startOffset": "xsd:integer",
      "endOffset": "xsd:integer",
      "parentBlockId": {
        "@type": "Optional",
        "@class": "xsd:string"
      }
    },
    {
      "@type": "Class",
      "@id": "SpanNode",
      "@key": {
        "@type": "Lexical",
        "@fields": ["spanId"]
      },
      "spanId": "xsd:string",
      "blockId": "xsd:string",
      "text": "xsd:string",
      "startOffset": "xsd:integer",
      "endOffset": "xsd:integer",
      "predicate": {
        "@type": "Optional",
        "@class": "xsd:string"
      }
    },
    {
      "@type": "Class",
      "@id": "TripleAssertion",
      "@key": {
        "@type": "Random"
      },
      "subjectId": "xsd:string",
      "predicate": "xsd:string",
      "objectId": "xsd:string",
      "provenance": "xsd:string",
      "timestamp": "xsd:string"
    },
    {
      "@type": "Class",
      "@id": "ArtifactNode",
      "@key": {
        "@type": "Lexical",
        "@fields": ["path"]
      },
      "path": "xsd:string",
      "contentHash": "xsd:string",
      "lastTrackedAt": "xsd:string",
      "ingestedHash": {
        "@type": "Optional",
        "@class": "xsd:string"
      },
      "lastIngestedAt": {
        "@type": "Optional",
        "@class": "xsd:string"
      },
      "docId": {
        "@type": "Optional",
        "@class": "xsd:string"
      }
    }
  ];
}
