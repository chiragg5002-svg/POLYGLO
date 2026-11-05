const {
  STORE_KEYS,
  analyzeStore,
  buildDatasetMetadata,
  analyzeRelationships,
  ruleBasedStoreAnalysis,
  interpretStoreAnalysisResponse,
  buildHybridDecision,
  computeDatasetNestedDepth,
} = require("../store-analysis-engine");

const { profileDataset } = require("../data-profiler");

function expectStoreScoreShape(entry) {
  expect(typeof entry.score).toBe("number");
  expect(entry.score).toBeGreaterThanOrEqual(0);
  expect(entry.score).toBeLessThanOrEqual(100);
  expect(Array.isArray(entry.reasons)).toBe(true);
  expect(entry.reasons.length).toBeGreaterThan(0);
}

function ollamaRejects(message = "Could not connect to Ollama.") {
  return async () => {
    throw new Error(message);
  };
}

function ollamaReturns(payload) {
  return async () => JSON.stringify(payload);
}

// ------------------------------------------------------------
// 1. Structured CSV -> PostgreSQL
// ------------------------------------------------------------
describe("structured CSV dataset", () => {
  const rows = [
    { order_id: "A1", customer_id: "C1", amount: "100" },
    { order_id: "A2", customer_id: "C1", amount: "250" },
    { order_id: "A3", customer_id: "C2", amount: "75" },
    { order_id: "A4", customer_id: "C2", amount: "40" },
  ];

  test("rule-based analysis favors PostgreSQL", async () => {
    const result = await analyzeStore({
      rows,
      originalName: "orders.csv",
      callOllamaFn: ollamaRejects(),
    });

    expectStoreScoreShape(result.ruleBased.postgresql);
    expectStoreScoreShape(result.ruleBased.mongodb);
    expectStoreScoreShape(result.ruleBased.elasticsearch);

    expect(result.ruleBased.postgresql.score).toBeGreaterThan(result.ruleBased.mongodb.score);
    expect(result.ruleBased.postgresql.score).toBeGreaterThan(result.ruleBased.elasticsearch.score);
    expect(result.hybrid.recommendation).toBe("postgresql");
  });
});

// ------------------------------------------------------------
// 2. Nested JSON -> MongoDB
// ------------------------------------------------------------
describe("nested JSON dataset", () => {
  const rows = [
    { user: { name: "Ada", tags: ["admin", "beta"] }, meta: { created: "2024-01-01" } },
    { user: { name: "Grace", tags: ["user"] }, meta: { created: "2024-01-02" } },
  ];

  test("rule-based analysis favors MongoDB", async () => {
    const result = await analyzeStore({
      rows,
      originalName: "users.json",
      callOllamaFn: ollamaRejects(),
    });

    expect(result.metadata.hasNestedData).toBe(true);
    expect(result.metadata.nestedDepth).toBeGreaterThanOrEqual(2);
    expect(result.ruleBased.mongodb.score).toBeGreaterThan(result.ruleBased.postgresql.score);
    expect(result.ruleBased.mongodb.score).toBeGreaterThan(result.ruleBased.elasticsearch.score);
    expect(result.hybrid.recommendation).toBe("mongodb");
  });
});

// ------------------------------------------------------------
// 3. Text-heavy dataset -> Elasticsearch
// ------------------------------------------------------------
describe("text-heavy dataset", () => {
  const rows = [
    {
      title: "Great laptop",
      description:
        "This laptop has an amazing battery life and a crisp display that makes it perfect for work and travel.",
    },
    {
      title: "Bad mouse",
      description: "The mouse stopped working within a week and the scroll wheel is extremely stiff and unreliable.",
    },
    {
      title: "Ok keyboard",
      description: "A mediocre keyboard with mushy keys, but the price point makes it acceptable for casual typists.",
    },
  ];

  test("rule-based analysis favors Elasticsearch", async () => {
    const result = await analyzeStore({
      rows,
      originalName: "reviews.csv",
      callOllamaFn: ollamaRejects(),
    });

    expect(result.ruleBased.elasticsearch.score).toBeGreaterThan(result.ruleBased.postgresql.score);
    expect(result.ruleBased.elasticsearch.score).toBeGreaterThan(result.ruleBased.mongodb.score);
    expect(result.hybrid.recommendation).toBe("elasticsearch");
  });
});

// ------------------------------------------------------------
// 4. Ollama unavailable -> rule-based fallback (never fails)
// ------------------------------------------------------------
describe("Ollama unavailable", () => {
  const rows = [
    { order_id: "A1", customer_id: "C1", amount: "100" },
    { order_id: "A2", customer_id: "C2", amount: "250" },
  ];

  test("falls back to the rule-based score instead of failing", async () => {
    const result = await analyzeStore({
      rows,
      originalName: "orders.csv",
      callOllamaFn: ollamaRejects("Could not connect to Ollama at 127.0.0.1:11434."),
    });

    expect(result.ollama.available).toBe(false);
    expect(result.hybrid.scores.postgresql).toBe(result.ruleBased.postgresql.score);
    expect(result.hybrid.scores.mongodb).toBe(result.ruleBased.mongodb.score);
    expect(result.hybrid.scores.elasticsearch).toBe(result.ruleBased.elasticsearch.score);
    expect(result.hybrid.warnings.some((warning) => /Ollama unavailable/i.test(warning))).toBe(true);
    expect(result.hybrid.agreement).toBe(true);
    expect(result.hybrid.ollamaRecommendation).toBeNull();
  });
});

// ------------------------------------------------------------
// 5. Ollama + Rule-Based agreement
// ------------------------------------------------------------
describe("Ollama and rule-based agreement", () => {
  const rows = [
    { order_id: "A1", customer_id: "C1", amount: "100" },
    { order_id: "A2", customer_id: "C2", amount: "250" },
  ];

  test("agreement is true and hybrid score blends both", async () => {
    const result = await analyzeStore({
      rows,
      originalName: "orders.csv",
      callOllamaFn: ollamaReturns({
        postgresql: 85,
        mongodb: 10,
        elasticsearch: 5,
        recommended_store: "postgresql",
        confidence: 80,
        reasons: ["Flat, relational-looking data."],
      }),
    });

    expect(result.ollama.available).toBe(true);
    expect(result.hybrid.ruleBasedRecommendation).toBe("postgresql");
    expect(result.hybrid.ollamaRecommendation).toBe("postgresql");
    expect(result.hybrid.agreement).toBe(true);
    expect(result.hybrid.recommendation).toBe("postgresql");

    const expected = Math.round(result.ruleBased.postgresql.score * 0.6 + 85 * 0.4);
    expect(result.hybrid.scores.postgresql).toBe(expected);
  });
});

// ------------------------------------------------------------
// 6. Ollama + Rule-Based disagreement
// ------------------------------------------------------------
describe("Ollama and rule-based disagreement", () => {
  const rows = [
    { fieldA: "alpha", fieldB: 12 },
    { fieldA: "beta", fieldB: 34 },
    { fieldA: "gamma", fieldB: 56 },
  ];

  test("disagreement is surfaced, not silently resolved", async () => {
    const result = await analyzeStore({
      rows,
      originalName: "ambiguous.csv",
      callOllamaFn: ollamaReturns({
        postgresql: 20,
        mongodb: 90,
        elasticsearch: 10,
        recommended_store: "mongodb",
        confidence: 70,
        reasons: ["Looks like flexible document data."],
      }),
    });

    expect(result.hybrid.ruleBasedRecommendation).toBe("postgresql");
    expect(result.hybrid.ollamaRecommendation).toBe("mongodb");
    expect(result.hybrid.agreement).toBe(false);
    expect(result.hybrid.warnings.some((warning) => /disagreement|recommends/i.test(warning) || /Ollama recommends/i.test(warning))).toBe(true);
    // Final call must be whatever the weighted score actually produced.
    expect(STORE_KEYS).toContain(result.hybrid.recommendation);
  });
});

// ------------------------------------------------------------
// 7. Relationship detection
// ------------------------------------------------------------
describe("relationship detection", () => {
  test("detects a primary-key candidate and a foreign-key/one-to-many candidate", () => {
    const rows = [
      { order_id: "A1", customer_id: "C1" },
      { order_id: "A2", customer_id: "C1" },
      { order_id: "A3", customer_id: "C2" },
      { order_id: "A4", customer_id: "C2" },
    ];
    const profile = profileDataset(rows, "orders.csv", { format: "csv" });
    const result = analyzeRelationships({ profile });

    const pk = result.relations.find((relation) => relation.type === "primary-key-candidate");
    const fk = result.relations.find((relation) => relation.type === "foreign-key-candidate");

    expect(pk).toBeDefined();
    expect(pk.field).toBe("order_id");
    expect(fk).toBeDefined();
    expect(fk.field).toBe("customer_id");
    expect(result.confidence).toBeGreaterThan(0);
  });

  test("never claims certainty — relations are candidates only", () => {
    const rows = [{ id: "1", status: "active" }, { id: "2", status: "inactive" }];
    const profile = profileDataset(rows, "items.csv", { format: "csv" });
    const result = analyzeRelationships({ profile });

    result.relations.forEach((relation) => {
      expect(relation.type).toMatch(/candidate|indicator|grouping/i);
      expect(relation.reason).toMatch(/candidate|suggest|indicate|possible|fits a primary key/i);
    });
  });

  test("returns an empty, zero-confidence result for too few rows", () => {
    const rows = [{ id: "1", name: "solo" }];
    const profile = profileDataset(rows, "solo.csv", { format: "csv" });
    const result = analyzeRelationships({ profile });

    expect(result.relations).toEqual([]);
    expect(result.confidence).toBe(0);
  });
});

// ------------------------------------------------------------
// 8. Invalid Ollama JSON response
// ------------------------------------------------------------
describe("invalid Ollama JSON response", () => {
  test("interpretStoreAnalysisResponse rejects non-JSON text", () => {
    const result = interpretStoreAnalysisResponse("this is not json at all");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not valid JSON/i);
  });

  test("interpretStoreAnalysisResponse rejects JSON missing a required score", () => {
    const result = interpretStoreAnalysisResponse(
      JSON.stringify({ postgresql: 50, mongodb: 50, recommended_store: "postgresql" }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/elasticsearch/i);
  });

  test("analyzeStore falls back gracefully when Ollama returns invalid JSON", async () => {
    const rows = [
      { order_id: "A1", customer_id: "C1", amount: "100" },
      { order_id: "A2", customer_id: "C2", amount: "250" },
    ];

    const result = await analyzeStore({
      rows,
      originalName: "orders.csv",
      callOllamaFn: async () => "{ not: valid json ",
    });

    expect(result.ollama.available).toBe(false);
    expect(result.hybrid.scores.postgresql).toBe(result.ruleBased.postgresql.score);
    expect(result.warnings.some((warning) => /Ollama unavailable/i.test(warning))).toBe(true);
  });

  test("interpretStoreAnalysisResponse derives recommended_store from scores when it is missing/invalid", () => {
    const result = interpretStoreAnalysisResponse(
      JSON.stringify({ postgresql: 10, mongodb: 90, elasticsearch: 5, recommended_store: "sqlite" }),
    );
    expect(result.valid).toBe(true);
    expect(result.recommended_store).toBe("mongodb");
  });
});

// ------------------------------------------------------------
// Extra coverage: metadata analysis + hybrid math + nested depth
// ------------------------------------------------------------
describe("buildDatasetMetadata", () => {
  test("classifies numeric/categorical/text/date/nested fields", () => {
    const rows = [
      { id: "1", status: "active", bio: "A very long biography text field that goes on for a while describing someone in detail.", age: "30", joined: "2024-01-01", tags: ["a", "b"] },
      { id: "2", status: "inactive", bio: "Another long biography paragraph with plenty of descriptive free-form text content.", age: "40", joined: "2024-02-01", tags: ["c"] },
      { id: "3", status: "active", bio: "A third biography paragraph, again fairly long and descriptive about this particular person.", age: "50", joined: "2024-03-01", tags: ["d"] },
      { id: "4", status: "active", bio: "A fourth long-form biography entry with enough free text to be treated as prose, not a label.", age: "60", joined: "2024-04-01", tags: ["e"] },
    ];
    const profile = profileDataset(rows, "people.json", { format: "json" });
    const metadata = buildDatasetMetadata(profile, rows);

    expect(metadata.numericFields).toContain("age");
    expect(metadata.dateFields).toContain("joined");
    expect(metadata.categoricalFields).toContain("status");
    expect(metadata.textFields).toContain("bio");
    expect(metadata.arrays).toContain("tags");
    expect(metadata.identifierLikeFields).toContain("id");
    expect(metadata.rowCount).toBe(4);
    expect(metadata.fieldCount).toBe(profile.columns.length);
  });
});

describe("computeDatasetNestedDepth", () => {
  test("returns 0 for flat rows", () => {
    expect(computeDatasetNestedDepth([{ a: 1, b: "x" }])).toBe(0);
  });

  test("returns increasing depth for deeper nesting", () => {
    expect(computeDatasetNestedDepth([{ a: { b: 1 } }])).toBe(1);
    expect(computeDatasetNestedDepth([{ a: { b: { c: 1 } } }])).toBe(2);
    expect(computeDatasetNestedDepth([{ a: [{ b: 1 }] }])).toBe(2);
  });
});

describe("buildHybridDecision", () => {
  const ruleBased = {
    postgresql: { score: 80, reasons: ["rule reason pg"] },
    mongodb: { score: 20, reasons: ["rule reason mongo"] },
    elasticsearch: { score: 10, reasons: ["rule reason es"] },
  };

  test("uses 60/40 weighting when Ollama is available", () => {
    const ollama = {
      available: true,
      scores: { postgresql: 60, mongodb: 60, elasticsearch: 60 },
      recommended_store: "postgresql",
      reasons: ["ollama reason"],
    };
    const hybrid = buildHybridDecision({ ruleBased, ollama });

    expect(hybrid.scores.postgresql).toBe(Math.round(80 * 0.6 + 60 * 0.4));
    expect(hybrid.scores.mongodb).toBe(Math.round(20 * 0.6 + 60 * 0.4));
    expect(hybrid.warnings).toEqual([]);
  });

  test("uses rule-based scores unmodified when Ollama is unavailable", () => {
    const ollama = { available: false, scores: null, error: "timeout" };
    const hybrid = buildHybridDecision({ ruleBased, ollama });

    expect(hybrid.scores).toEqual({ postgresql: 80, mongodb: 20, elasticsearch: 10 });
    expect(hybrid.recommendation).toBe("postgresql");
    expect(hybrid.warnings[0]).toMatch(/Ollama unavailable/);
  });
});

// ------------------------------------------------------------
// ruleBasedStoreAnalysis always returns the full required shape
// ------------------------------------------------------------
describe("ruleBasedStoreAnalysis shape", () => {
  test("always returns scored + reasoned entries for all three stores", () => {
    const rows = [{ a: "x", b: "y" }];
    const profile = profileDataset(rows, "misc.csv", { format: "csv" });
    const relationships = analyzeRelationships({ profile });
    const result = ruleBasedStoreAnalysis({ profile, relationships, originalName: "misc.csv", rows });

    STORE_KEYS.forEach((key) => {
      expect(result).toHaveProperty(key);
      expectStoreScoreShape(result[key]);
    });
  });
});
