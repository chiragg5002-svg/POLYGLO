export interface MaestroOptions { apiKey?: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number; fetch?: typeof fetch; }
export interface Document<T = Record<string, unknown>> { id: string; data: T; createdAt: string; updatedAt: string; }
export type Scalar = string | number | boolean | null;
export type Filters = Record<string, Scalar | { eq?: Scalar; ne?: Scalar; gt?: number | string; gte?: number | string; lt?: number | string; lte?: number | string; in?: Scalar[] }>;
export interface FindOptions { sort?: string | { field: string; direction?: "asc" | "desc" }; limit?: number; offset?: number; }
export class MaestroError extends Error { status?: number; code?: string; details?: unknown; retryAfter?: number; }
export class AuthenticationError extends MaestroError {}
export class PermissionError extends MaestroError {}
export class QuotaExceededError extends PermissionError {}
export class NotFoundError extends MaestroError {}
export class ConflictError extends MaestroError {}
export class ValidationError extends MaestroError {}
export class RateLimitError extends MaestroError {}
export class ServerError extends MaestroError {}
export class TimeoutError extends MaestroError {}
export class NetworkError extends MaestroError {}
export interface ImportReport { importId: string; status: "success" | "partial" | "failed" | "dry_run"; success: boolean; summary: { total: number; valid: number; invalid: number; inserted: number; replaced: number; skipped: number; failed: number; aborted?: string }; errors: { row: number; message: string }[]; errorsTruncated: boolean; routing?: { dbType: string; source: string; reason?: string }; schema: { rows: number; fields: unknown[] }; warnings: string[] }
export interface ImportOptions { filename?: string; dryRun?: boolean; idField?: string; onDuplicate?: "skip" | "error" | "replace"; storageHint?: "postgresql" | "mongodb" | "elasticsearch" }
export class Collection<T = Record<string, unknown>> {
  insert(data: T): Promise<Document<T>>;
  find(filters?: Filters, options?: FindOptions): Promise<Document<T>[]>;
  findOne(filters?: Filters, options?: FindOptions): Promise<Document<T> | null>;
  get(id: string): Promise<Document<T> | null>;
  search(text: string, options?: FindOptions & { fields?: string[]; filters?: Filters }): Promise<Document<T>[]>;
  count(filters?: Filters): Promise<number>;
  update(id: string, data: T): Promise<Document<T>>;
  patch(id: string, data: Partial<T>): Promise<Document<T>>;
  delete(id: string): Promise<boolean>;
  info(): Promise<unknown>;
}
export class Maestro {
  importFile(collection: string, file: string | Uint8Array | Blob, options?: ImportOptions): Promise<ImportReport>;
  imports(): Promise<{ imports: unknown[] }>;
  constructor(options?: MaestroOptions);
  collection<T = Record<string, unknown>>(name: string): Collection<T>;
  createCollection(name: string, options?: { sampleData?: Record<string, unknown>; storageHint?: "postgresql" | "mongodb" | "elasticsearch" }): Promise<unknown>;
  listCollections(): Promise<Array<{ name: string; dbType: string; routingReason: string; createdAt: string }>>;
  getCollection(name: string): Promise<unknown>;
  dropCollection(name: string): Promise<unknown>;
  usage(): Promise<unknown>;
  project(): Promise<unknown>;
  query(body: Record<string, unknown>): Promise<{ results: Document[]; resultCount: number; cached: boolean }>;
}
export default Maestro;
