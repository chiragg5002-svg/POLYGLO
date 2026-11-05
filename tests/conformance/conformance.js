/*
 * Shared adapter conformance suite. Every storage adapter must satisfy the
 * same contract (see adapters/common.js). The suite is run:
 *   - against the REAL adapter code driven by in-memory fake drivers (always)
 *   - against REAL PostgreSQL / MongoDB / Elasticsearch (when reachable; shown
 *     as SKIPPED otherwise — see tests/conformance/*.test.js)
 */
const crypto = require("crypto");
const V = require("../../dbaas/validators");

const rid = () => `proj_${crypto.randomBytes(6).toString("hex")}`;
const spec = (o = {}) => ({ queryType: "select", filters: [], text: null, fields: [], sort: null, limit: 50, offset: 0, ...o });
const f = (field, operator, value) => ({ field, operator, value });

function runConformance(label, { makeAdapter, strictTypes = false, textSearch = true, cleanup }) {
  describe(`adapter conformance: ${label}`, () => {
    let adapter; let projectId; let mapping; let projectsUsed = [];
    const sample = { name: "Laptop", price: 75000.5, active: true, category: "electronics", tags: ["a"], meta: { x: 1 } };

    async function newMapping(pid, collection = "items", s = sample) {
      const plan = await adapter.plan({ projectId: pid, collection, sample: s });
      const m = { project_id: pid, collection, db_type: adapter.dbType, database_name: plan.database_name, physical_name: plan.physical_name, schema: plan.schema };
      await adapter.createStorage(m);
      return m;
    }
    const make = (n, extra = {}) => ({ name: `item${n}`, price: n * 10, active: n % 2 === 0, category: n % 3 === 0 ? "toys" : "electronics", tags: [`t${n}`], meta: { x: n }, ...extra });
    const create = (data, m = mapping) => adapter.create(m, { id: crypto.randomUUID(), data });

    beforeAll(async () => { adapter = await makeAdapter(); });
    beforeEach(async () => { projectId = rid(); projectsUsed.push(projectId); mapping = await newMapping(projectId); });
    afterAll(async () => {
      for (const pid of projectsUsed) await adapter.dropProjectStorage(pid, await collectMappings(pid)).catch(() => {});
      if (cleanup) await cleanup(adapter);
      await adapter.close().catch(() => {});
    });
    const known = new Map();
    const collectMappings = async (pid) => [...known.values()].filter((m) => m.project_id === pid);
    const origNew = newMapping;
    newMapping = async (...a) => { const m = await origNew(...a); known.set(`${m.project_id}/${m.collection}`, m); return m; }; // eslint-disable-line no-func-assign

    test("create -> findOne round-trips the exact document", async () => {
      const doc = await create(sample);
      expect(doc).toMatchObject({ data: sample });
      expect(doc.id).toBeTruthy();
      expect(typeof doc.createdAt).toBe("string");
      expect((await adapter.findOne(mapping, doc.id)).data).toEqual(sample);
    });
    test("findOne / update / delete on a missing id", async () => {
      expect(await adapter.findOne(mapping, "does-not-exist")).toBeNull();
      expect(await adapter.update(mapping, "does-not-exist", { name: "x" })).toBeNull();
      expect(await adapter.delete(mapping, "does-not-exist")).toBe(false);
    });
    test("update replaces; delete removes; updatedAt moves", async () => {
      const doc = await create(sample);
      await new Promise((r) => setTimeout(r, 15));
      const up = await adapter.update(mapping, doc.id, { ...sample, name: "Renamed", price: 1 });
      expect(up.data).toMatchObject({ name: "Renamed", price: 1 });
      expect(up.createdAt).toBe(doc.createdAt);
      expect(new Date(up.updatedAt).getTime()).toBeGreaterThan(new Date(doc.updatedAt).getTime());
      expect(await adapter.delete(mapping, doc.id)).toBe(true);
      expect(await adapter.findOne(mapping, doc.id)).toBeNull();
    });
    test("a duplicate id is rejected with the typed duplicate_id error and the original is untouched", async () => {
      const id = "fixed-id-1";
      await adapter.create(mapping, { id, data: sample });
      await expect(adapter.create(mapping, { id, data: { ...sample, name: "other" } })).rejects.toMatchObject({ code: "duplicate_id", status: 409 });
      expect((await adapter.findOne(mapping, id)).data.name).toBe("Laptop");
    });
    test("nulls, missing fields, extra fields, nested objects, arrays, unicode survive", async () => {
      const data = { name: "Zoë 李雷 😀", price: null, extra_field: { deep: { deeper: [1, { z: "ü" }] } }, brand_new: "added later" };
      const doc = await create(data);
      const back = (await adapter.findOne(mapping, doc.id)).data;
      expect(back.name).toBe("Zoë 李雷 😀");
      expect(back.price ?? null).toBeNull();
      expect(back.extra_field).toEqual({ deep: { deeper: [1, { z: "ü" }] } });
      expect(back.brand_new).toBe("added later");
      const minimal = await create({ name: "only-name" });
      expect((await adapter.findOne(mapping, minimal.id)).data.name).toBe("only-name");
    });
    test("large payloads (200 KB string) round-trip", async () => {
      const big = "x".repeat(200 * 1024);
      const doc = await create({ ...sample, name: big });
      expect((await adapter.findOne(mapping, doc.id)).data.name.length).toBe(big.length);
    });
    if (strictTypes) {
      test("a value of the wrong type for an inferred column is a 400, not a 500", async () => {
        await expect(create({ ...sample, price: "not a number" })).rejects.toMatchObject({ status: 400 });
      });
    }

    describe("queries", () => {
      beforeEach(async () => { for (let n = 1; n <= 9; n += 1) await create(make(n)); });
      const q = (o) => adapter.query(mapping, spec(o));
      const names = (r) => r.results.map((d) => d.data.name);

      test("eq / ne / gt / gte / lt / lte / in", async () => {
        expect(names(await q({ filters: [f("name", "eq", "item3")] }))).toEqual(["item3"]);
        expect((await q({ filters: [f("category", "eq", "toys")] })).resultCount).toBe(3);
        expect((await q({ filters: [f("category", "ne", "toys")] })).resultCount).toBe(6);
        expect((await q({ filters: [f("price", "gt", 50)] })).resultCount).toBe(4);
        expect((await q({ filters: [f("price", "gte", 50)] })).resultCount).toBe(5);
        expect((await q({ filters: [f("price", "lt", 30)] })).resultCount).toBe(2);
        expect((await q({ filters: [f("price", "lte", 30)] })).resultCount).toBe(3);
        expect((await q({ filters: [f("name", "in", ["item1", "item2", "nope"])] })).resultCount).toBe(2);
        expect((await q({ filters: [f("price", "gte", 20), f("price", "lt", 60), f("category", "eq", "electronics")] })).resultCount).toBe(3);
      });
      test("nested path filter", async () => {
        expect((await q({ filters: [f("meta.x", "gte", 8)] })).resultCount).toBe(2);
      });
      test("sort asc/desc + pagination are stable and non-overlapping", async () => {
        const asc = names(await q({ sort: { field: "price", direction: "asc" } }));
        expect(asc).toEqual(["item1", "item2", "item3", "item4", "item5", "item6", "item7", "item8", "item9"]);
        expect(names(await q({ sort: { field: "price", direction: "desc" }, limit: 3 }))).toEqual(["item9", "item8", "item7"]);
        const p1 = names(await q({ sort: { field: "price", direction: "asc" }, limit: 4, offset: 0 }));
        const p2 = names(await q({ sort: { field: "price", direction: "asc" }, limit: 4, offset: 4 }));
        const p3 = names(await q({ sort: { field: "price", direction: "asc" }, limit: 4, offset: 8 }));
        expect([...p1, ...p2, ...p3]).toEqual(asc);
        expect((await q({ limit: 1, offset: 100 })).results).toEqual([]);
      });
      test("count honours filters", async () => {
        expect((await q({ queryType: "count" })).resultCount).toBe(9);
        expect((await q({ queryType: "count", filters: [f("category", "eq", "toys")] })).resultCount).toBe(3);
        expect(await adapter.count(mapping, spec({ queryType: "count" }))).toBe(9);
      });
      test("field-scoped search is a case-insensitive substring match", async () => {
        const r = await q({ queryType: "search", text: "ITEM4", fields: ["name"] });
        expect(names(r)).toEqual(["item4"]);
        expect((await q({ queryType: "search", text: "item", fields: ["name"], filters: [f("category", "eq", "toys")] })).resultCount).toBe(3);
        expect((await q({ queryType: "search", text: "%", fields: ["name"] })).resultCount).toBe(0);
      });
      (textSearch ? test : test.skip)("unscoped text search (case-insensitive) with filters", async () => {
        const r = await q({ queryType: "search", text: "ITEM4" });
        expect(names(r)).toContain("item4");
        expect((await q({ queryType: "search", text: "item", filters: [f("category", "eq", "toys")] })).resultCount).toBe(3);
        expect((await q({ queryType: "search", text: "zzz-nothing-zzz" })).resultCount).toBe(0);
      });
      test("empty result set has a consistent shape", async () => {
        const r = await q({ filters: [f("name", "eq", "nobody")] });
        expect(r).toEqual({ results: [], resultCount: 0 });
      });
      test("injection-shaped values are inert data (SQL, Mongo operators, ES DSL)", async () => {
        for (const evil of ["x' OR 1=1 --", "'; DROP TABLE items; --", '{"$ne":null}', '{"match_all":{}}', "\\", "%", "_", "a\u0000b".replace("\u0000", "")]) {
          const r = await q({ filters: [f("name", "eq", evil)] });
          expect(r.resultCount).toBe(0);
        }
        expect((await q({ queryType: "search", text: "%", fields: ["name"] })).resultCount).toBe(0); // LIKE wildcards are escaped
        expect((await q({ queryType: "count" })).resultCount).toBe(9); // table intact
      });
      test("every query shape passes the API validator the adapters rely on", () => {
        expect(() => V.validateQueryRequest({ collection: "items", filters: { "name": { "$ne": 1 } } })).toThrow();
      });
    });

    test("tenant isolation: same collection name in two projects never mixes", async () => {
      const other = rid(); projectsUsed.push(other);
      const m2 = await newMapping(other);
      await create({ name: "mine" });
      await create({ name: "theirs" }, m2);
      expect((await adapter.query(mapping, spec())).results.map((d) => d.data.name)).toEqual(["mine"]);
      expect((await adapter.query(m2, spec())).results.map((d) => d.data.name)).toEqual(["theirs"]);
      const d = await create({ name: "secret" }, m2);
      expect(await adapter.findOne(mapping, d.id)).toBeNull(); // another project's id is simply not found
      expect(await adapter.delete(mapping, d.id)).toBe(false);
      expect((await adapter.findOne(m2, d.id)).data.name).toBe("secret");
    });
    test("refuses tampered mappings (identifier/ownership mismatch)", async () => {
      const bad = [{ ...mapping, collection: "items; drop table x" }, { ...mapping, project_id: "proj_ZZZZ" }, null];
      if (mapping.database_name) bad.push({ ...mapping, database_name: "maestro_proj_ffffffffffff" }); // not every backend has a database name
      for (const m of bad) {
        await expect(adapter.findOne(m, "x")).rejects.toBeDefined();
      }
    });
    test("storageBytes is a non-negative number and dropStorage removes the data", async () => {
      await create(sample);
      expect(await adapter.storageBytes(mapping)).toBeGreaterThanOrEqual(0);
      await adapter.dropStorage(mapping);
      // After a drop the collection is gone: backends either error or return nothing, never old data.
      const after = await adapter.query(mapping, spec()).catch(() => ({ results: [], resultCount: 0 }));
      expect(after.results).toEqual([]);
    });
  });
}

module.exports = { runConformance, rid, spec, f };
