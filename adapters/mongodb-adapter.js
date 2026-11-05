/*
 * MongoDB storage adapter.
 *
 * Layout: one MongoDB database per project (`maestro_<projectId>`),
 * one MongoDB collection per logical collection. Documents are stored
 * in an envelope { _id, data, createdAt, updatedAt } so client field
 * names can never collide with Mongo internals. Query documents are
 * built clause-by-clause from validated { field, operator, value }
 * triples; operator keys come from a fixed map and values are always
 * scalars (the validator rejects objects), so a client cannot inject
 * $where/$function/other operators.
 */
const { MongoClient } = require("mongodb");
const { getConfig } = require("../dbaas/config");
const { badRequest, duplicate } = require("../dbaas/errors");
const { assertSafeMapping, internalStoreError, escapeRegex } = require("./common");

const OPS = { ne: "$ne", gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte", in: "$in" };

class MongoDbAdapter {
  // `clientFactory` is injectable so tests can supply a fake driver.
  constructor({ clientFactory } = {}) {
    this._factory = clientFactory || (() => { const t = getConfig().dbTimeoutMs; return new MongoClient(getConfig().mongoUri(), { serverSelectionTimeoutMS: t, connectTimeoutMS: t, socketTimeoutMS: t * 2, maxPoolSize: 20 }); });
    this._client = null;
    this._connecting = null;
    this.dbType = "mongodb";
  }

  async _getClient() {
    if (this._client) return this._client;
    if (!this._connecting) {
      this._connecting = (async () => {
        const c = this._factory();
        await c.connect();
        this._client = c;
        return c;
      })().finally(() => { this._connecting = null; });
    }
    return this._connecting;
  }

  async _coll(mapping) {
    assertSafeMapping(mapping);
    if (mapping.database_name !== `maestro_${mapping.project_id}`) throw new Error("Mapping/database mismatch.");
    const client = await this._getClient();
    return client.db(mapping.database_name).collection(mapping.physical_name);
  }

  async close() {
    if (this._client) await this._client.close().catch(() => {});
    this._client = null;
  }

  async ping() {
    const c = await this._getClient();
    await c.db("admin").command({ ping: 1 });
    return true;
  }

  async plan({ projectId, collection }) {
    return { database_name: `maestro_${projectId}`, physical_name: collection, schema: null };
  }

  async createStorage(mapping) {
    try {
      assertSafeMapping(mapping);
      const client = await this._getClient();
      const db = client.db(mapping.database_name);
      try {
        await db.createCollection(mapping.physical_name);
      } catch (e) {
        if (e.code !== 48 && e.codeName !== "NamespaceExists") throw e;
      }
      const coll = db.collection(mapping.physical_name);
      await coll.createIndex({ createdAt: 1, _id: 1 });
      try {
        await coll.createIndex({ "$**": "text" }, { name: "maestro_text" });
      } catch (e) {
        // MongoDB-compatible servers without wildcard text indexes still work for
        // everything except unscoped text search (search with "fields" uses a regex).
        console.warn(`[maestro] mongodb: text index unavailable (${e.message}); unscoped search will not work for this collection.`);
      }
    } catch (e) {
      throw internalStoreError("mongodb createStorage", e);
    }
  }

  _toDoc(row) {
    if (!row) return null;
    return {
      id: String(row._id),
      data: row.data || {},
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    };
  }

  _filter(spec) {
    const filter = {};
    const and = [];
    for (const { field, operator, value } of spec.filters || []) {
      const path = `data.${field}`;
      if (operator === "eq") and.push({ [path]: value });
      else and.push({ [path]: { [OPS[operator]]: value } });
    }
    if (spec.queryType === "search" && spec.text) {
      if (spec.fields && spec.fields.length) {
        const re = new RegExp(escapeRegex(spec.text), "i");
        and.push({ $or: spec.fields.map((f) => ({ [`data.${f}`]: { $regex: re } })) });
      } else {
        and.push({ $text: { $search: spec.text } });
      }
    }
    if (and.length) filter.$and = and;
    return filter;
  }

  async create(mapping, { id, data }) {
    const coll = await this._coll(mapping);
    const now = new Date();
    try {
      await coll.insertOne({ _id: id, data, createdAt: now, updatedAt: now });
      return this._toDoc({ _id: id, data, createdAt: now, updatedAt: now });
    } catch (e) {
      if (e.code === 11000) throw duplicate();
      throw internalStoreError("mongodb create", e);
    }
  }

  async findOne(mapping, id) {
    const coll = await this._coll(mapping);
    try {
      return this._toDoc(await coll.findOne({ _id: id }));
    } catch (e) {
      throw internalStoreError("mongodb findOne", e);
    }
  }

  async update(mapping, id, data) {
    const coll = await this._coll(mapping);
    try {
      const res = await coll.findOneAndUpdate(
        { _id: id }, { $set: { data, updatedAt: new Date() } }, { returnDocument: "after" });
      const row = res && Object.prototype.hasOwnProperty.call(res, "value") && !res._id ? res.value : res;
      return this._toDoc(row);
    } catch (e) {
      throw internalStoreError("mongodb update", e);
    }
  }

  async delete(mapping, id) {
    const coll = await this._coll(mapping);
    try {
      const r = await coll.deleteOne({ _id: id });
      return r.deletedCount > 0;
    } catch (e) {
      throw internalStoreError("mongodb delete", e);
    }
  }

  async find(mapping, spec) {
    const coll = await this._coll(mapping);
    try {
      const sort = spec.sort
        ? { [`data.${spec.sort.field}`]: spec.sort.direction === "desc" ? -1 : 1, _id: 1 }
        : { createdAt: 1, _id: 1 };
      const rows = await coll.find(this._filter(spec)).sort(sort).skip(spec.offset || 0).limit(spec.limit).toArray();
      const results = rows.map((r) => this._toDoc(r));
      return { results, resultCount: results.length };
    } catch (e) {
      throw internalStoreError("mongodb find", e);
    }
  }

  async count(mapping, spec) {
    const coll = await this._coll(mapping);
    try {
      return await coll.countDocuments(this._filter(spec));
    } catch (e) {
      throw internalStoreError("mongodb count", e);
    }
  }

  async query(mapping, spec) {
    if (spec.queryType === "count") return { results: [], resultCount: await this.count(mapping, spec) };
    return this.find(mapping, spec);
  }

  async storageBytes(mapping) {
    try {
      const coll = await this._coll(mapping);
      const stats = await coll.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      const storageStats = stats[0] && stats[0].storageStats;
      const rawCollectionBytes = storageStats && storageStats.storageSize;
      const rawIndexBytes = storageStats && storageStats.totalIndexSize;
      if (rawCollectionBytes === null || rawCollectionBytes === undefined ||
          rawIndexBytes === null || rawIndexBytes === undefined) {
        throw new Error("MongoDB did not return collection and index storage sizes.");
      }
      const collectionBytes = Number(rawCollectionBytes);
      const indexBytes = Number(rawIndexBytes);
      if (!Number.isSafeInteger(collectionBytes) || collectionBytes < 0 ||
          !Number.isSafeInteger(indexBytes) || indexBytes < 0) {
        throw new Error("MongoDB did not return valid collection and index storage sizes.");
      }
      const totalBytes = collectionBytes + indexBytes;
      if (!Number.isSafeInteger(totalBytes)) throw new Error("MongoDB storage size exceeds the supported integer range.");
      return totalBytes;
    } catch (e) {
      throw internalStoreError("mongodb storage measurement", e);
    }
  }

  async dropStorage(mapping) {
    try {
      const coll = await this._coll(mapping);
      await coll.drop().catch((e) => { if (e.code !== 26 && e.codeName !== "NamespaceNotFound") throw e; });
    } catch (e) {
      throw internalStoreError("mongodb dropStorage", e);
    }
  }

  async dropProjectStorage(projectId, mappings) {
    if (!mappings.some((m) => m.database_name === `maestro_${projectId}`)) return;
    const client = await this._getClient();
    await client.db(`maestro_${projectId}`).dropDatabase();
  }
}

module.exports = { MongoDbAdapter };
