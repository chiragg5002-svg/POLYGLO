const request = require("supertest");
const { buildTestApp } = require("./_app");

let ctx;
let app;

beforeEach(() => {
  ctx = buildTestApp();
  app = ctx.app;
});

async function createAccount(email = "client@example.test", password = "correct horse battery") {
  const agent = request.agent(app);
  const response = await agent.post("/v1/client/auth/register").send({
    displayName: "Example Client", email, password,
  });
  return { agent, response };
}

async function register(email = "client@example.test", password = "correct horse battery") {
  const { response } = await createAccount(email, password);
  const agent = request.agent(app);
  const login = await agent.post("/v1/client/auth/login").send({ email, password });
  if (login.status !== 200) throw new Error(`Client login failed with status ${login.status}.`);
  return { agent, response };
}

async function createProject(agent, name = "Portal project", scopes = ["data:read", "data:write", "collections:manage", "usage:read"]) {
  return agent.post("/v1/client/projects").send({ name, scopes, ownerClientId: "client_attacker_supplied" });
}

describe("client account authentication", () => {
  test("registration does not authenticate; password sign-in immediately persists a session", async () => {
    const { agent: registrationAgent, response } = await createAccount();
    expect(response.status).toBe(201);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body.account).toMatchObject({ email: "client@example.test", displayName: "Example Client" });
    expect(JSON.stringify(response.body)).not.toContain("correct horse battery");
    expect((await registrationAgent.get("/v1/client/auth/me")).status).toBe(401);

    const stored = await ctx.store.getClientByEmail("client@example.test");
    expect(stored.password_hash).toMatch(/^scrypt\$/);
    expect(stored.password_hash).not.toContain("correct horse battery");

    expect((await request(app).post("/v1/client/auth/login").send({
      email: "client@example.test", password: "wrong password",
    })).status).toBe(401);
    const loginAgent = request.agent(app);
    const login = await loginAgent.post("/v1/client/auth/login").send({
      email: "CLIENT@example.test", password: "correct horse battery",
    });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      success: true,
      account: expect.objectContaining({
        clientId: expect.any(String), email: "client@example.test", displayName: "Example Client",
      }),
    });
    expect(login.headers["set-cookie"][0]).toMatch(/HttpOnly/);
    expect(login.headers["set-cookie"][0]).toMatch(/SameSite=Strict/);
    expect(login.headers["set-cookie"][0]).toMatch(/maestro_client_session=/);
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(ctx.store.clientSessions.size).toBe(1);
    expect((await loginAgent.get("/v1/client/auth/me")).body.account.email).toBe("client@example.test");
    expect((await loginAgent.post("/v1/client/auth/logout").send({})).status).toBe(200);
    expect(ctx.store.clientSessions.size).toBe(0);
    expect((await loginAgent.get("/v1/client/auth/me")).status).toBe(401);
  });

  test("password login succeeds when email delivery is unavailable", async () => {
    const failing = buildTestApp({
      mailer: {
        async sendOtp() {
          throw new Error("SMTP must not be called during password login.");
        },
      },
    });
    await request(failing.app).post("/v1/client/auth/register").send({
      displayName: "Example Client", email: "offline@example.test", password: "correct horse battery",
    });
    const loginAgent = request.agent(failing.app);
    const login = await loginAgent.post("/v1/client/auth/login").send({
      email: "offline@example.test", password: "correct horse battery",
    });
    expect(login.status).toBe(200);
    expect(login.headers["set-cookie"][0]).toMatch(/HttpOnly/);
    expect(failing.store.clientSessions.size).toBe(1);
    expect((await loginAgent.get("/v1/client/auth/me")).status).toBe(200);
  });

  test("validates registration input and rejects expired or signed-out sessions", async () => {
    expect((await request(app).post("/v1/client/auth/register").send({
      displayName: "X", email: "not-an-email", password: "short",
    })).status).toBe(400);
    const { agent, response } = await register();
    expect(response.status).toBe(201);

    const session = [...ctx.store.clientSessions.values()][0];
    session.expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await agent.get("/v1/client/auth/me")).status).toBe(401);
    const { agent: currentAgent } = await register("second@example.test");
    expect((await currentAgent.post("/v1/client/auth/logout").send({})).status).toBe(200);
    expect((await currentAgent.get("/v1/client/auth/me")).status).toBe(401);
  });

  test("rejects duplicate accounts and cross-origin account mutations", async () => {
    await register();
    expect((await request(app).post("/v1/client/auth/register").send({
      displayName: "Another", email: "CLIENT@example.test", password: "correct horse battery",
    })).status).toBe(409);
    const blocked = await request(app).post("/v1/client/auth/register")
      .set("Origin", "https://attacker.example")
      .send({ displayName: "Attacker", email: "attacker@example.test", password: "correct horse battery" });
    expect(blocked.status).toBe(403);
    expect(await ctx.store.getClientByEmail("attacker@example.test")).toBeNull();
  });

  test("rate limits repeated client authentication attempts", async () => {
    const prior = process.env.MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE;
    process.env.MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE = "2";
    const limited = buildTestApp();
    try {
      const credentials = { email: "nobody@example.test", password: "incorrect password" };
      expect((await request(limited.app).post("/v1/client/auth/login").send(credentials)).status).toBe(401);
      expect((await request(limited.app).post("/v1/client/auth/login").send(credentials)).status).toBe(401);
      expect((await request(limited.app).post("/v1/client/auth/login").send(credentials)).status).toBe(429);
    } finally {
      if (prior === undefined) delete process.env.MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE;
      else process.env.MAESTRO_AUTH_FAIL_LIMIT_PER_MINUTE = prior;
    }
  });
});

describe("client database browsing", () => {
  async function makeReadableProject(agent, name = "Browse project") {
    const project = await createProject(agent, name);
    expect(project.status).toBe(201);
    const authorization = { Authorization: `Bearer ${project.body.apiKey}` };
    const collection = await request(app).post("/v1/collections").set(authorization).send({
      name: "items", sampleData: { name: "first", details: { color: "blue" } },
    });
    expect(collection.status).toBe(201);
    const first = await request(app).post("/v1/data").set(authorization).send({
      collection: "items", data: { name: "first", details: { color: "blue" } },
    });
    const second = await request(app).post("/v1/data").set(authorization).send({
      collection: "items", data: { name: "second" },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    return { project: project.body, authorization, first, second };
  }

  test("requires a client session, an owned project, and a matching data:read key", async () => {
    const { agent: alice } = await register("browse-alice@example.test");
    const { agent: bob } = await register("browse-bob@example.test");
    const { project, authorization } = await makeReadableProject(alice);
    const endpoint = `/v1/client/projects/${project.projectId}/browse/items`;

    expect((await request(app).get(endpoint).set(authorization)).status).toBe(401);
    expect((await alice.get(endpoint)).status).toBe(401);
    expect((await bob.get(endpoint).set(authorization)).status).toBe(404);

    const aliceProject = await createProject(alice, "Second owned project", ["data:read"]);
    const mismatched = await alice.get(
      `/v1/client/projects/${aliceProject.body.projectId}/browse/items`,
    ).set(authorization);
    expect(mismatched.status).toBe(403);

    const writeOnlyKey = await alice.post(
      `/v1/client/projects/${project.projectId}/keys`,
    ).send({ scopes: ["data:write"] });
    expect(writeOnlyKey.status).toBe(201);
    const insufficient = await alice.get(endpoint).set({
      Authorization: `Bearer ${writeOnlyKey.body.apiKey}`,
    });
    expect(insufficient.status).toBe(403);
    expect(insufficient.body.error.code).toBe("insufficient_scope");
  });

  test("reads an owned collection with bounded server-side pagination and rejects invalid input", async () => {
    const { agent: alice } = await register("browse-pages@example.test");
    const { project, authorization, first, second } = await makeReadableProject(alice);
    const endpoint = `/v1/client/projects/${project.projectId}/browse/items`;
    const page = await alice.get(`${endpoint}?limit=1&offset=1`).set(authorization);

    expect(page.status).toBe(200);
    expect(page.body.results).toHaveLength(1);
    expect(page.body.results[0].id).toBe(second.body.id);
    expect(page.body.results[0]).toMatchObject({
      data: { name: "second" }, createdAt: expect.any(String), updatedAt: expect.any(String),
    });
    expect((await alice.get(`${endpoint}?limit=51`).set(authorization)).status).toBe(400);
    expect((await alice.get(`${endpoint}?offset=-1`).set(authorization)).status).toBe(400);
    expect((await alice.get(
      `/v1/client/projects/${project.projectId}/browse/not-valid`,
    ).set(authorization)).status).toBe(400);
    expect((await alice.get(
      `/v1/client/projects/${project.projectId}/browse/missing`,
    ).set(authorization)).status).toBe(404);
    expect(first.body.id).toBeDefined();
  });

  test("returns an empty page for an empty collection", async () => {
    const { agent: alice } = await register("browse-empty@example.test");
    const project = await createProject(alice, "Empty collection", ["data:read", "data:write", "collections:manage"]);
    const authorization = { Authorization: `Bearer ${project.body.apiKey}` };
    const created = await request(app).post("/v1/collections").set(authorization).send({ name: "empty" });
    expect(created.status).toBe(201);
    const result = await alice.get(
      `/v1/client/projects/${project.body.projectId}/browse/empty`,
    ).set(authorization);
    expect(result.status).toBe(200);
    expect(result.body.results).toEqual([]);
  });
});

describe("client projects and ownership", () => {
  test("scopes idempotency keys by client account", async () => {
    const { agent: alice } = await register();
    const { agent: bob } = await register("bob@example.test");
    const first = await alice.post("/v1/client/projects")
      .set("Idempotency-Key", "shared-key-value-123").send({ name: "Alice project" });
    const second = await bob.post("/v1/client/projects")
      .set("Idempotency-Key", "shared-key-value-123").send({ name: "Bob project" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.projectId).not.toBe(first.body.projectId);
    const replay = await alice.post("/v1/client/projects")
      .set("Idempotency-Key", "shared-key-value-123").send({ name: "Alice project" });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.apiKey).toBeUndefined();
  });

  test("creates an owned project and keeps project, key, and usage details private", async () => {
    const { agent: alice, response } = await register();
    expect(response.status).toBe(201);
    const created = await createProject(alice);
    expect(created.status).toBe(201);
    expect(created.body.projectId).toMatch(/^proj_[0-9a-f]{12}$/);
    expect(created.body.apiKey).toMatch(/^pk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(created.body.scopes).toEqual(["data:read", "data:write", "collections:manage", "usage:read"]);

    const { agent: bob } = await register("bob@example.test");
    expect((await alice.get("/v1/client/projects")).body.projects).toHaveLength(1);
    expect((await bob.get("/v1/client/projects")).body.projects).toHaveLength(0);
    for (const endpoint of [
      `/v1/client/projects/${created.body.projectId}`,
      `/v1/client/projects/${created.body.projectId}/usage`,
      `/v1/client/projects/${created.body.projectId}/keys`,
    ]) {
      expect((await bob.get(endpoint)).status).toBe(404);
    }
    expect((await request(app).get(`/v1/client/projects/${created.body.projectId}/usage`)).status).toBe(401);
    const detail = await alice.get(`/v1/client/projects/${created.body.projectId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(created.body.apiKey);
    expect((await alice.get(`/v1/client/projects/${created.body.projectId}/usage`)).status).toBe(200);
  });

  test("enforces read-only scopes, prevents cross-project claims, and revokes client keys", async () => {
    const { agent: alice } = await register();
    const project = await createProject(alice, "Scope test");
    const ownerKey = project.body.apiKey;
    const ownerAuth = { Authorization: `Bearer ${ownerKey}` };
    const collection = await request(app).post("/v1/collections").set(ownerAuth).send({ name: "items" });
    expect(collection.status).toBe(201);
    const inserted = await request(app).post("/v1/data").set(ownerAuth).send({
      collection: "items", data: { name: "one" },
    });
    expect(inserted.status).toBe(201);

    const readOnly = await alice.post(`/v1/client/projects/${project.body.projectId}/keys`).send({
      label: "read-only", scopes: ["data:read"],
    });
    expect(readOnly.status).toBe(201);
    expect(readOnly.body.scopes).toEqual(["data:read"]);
    expect(JSON.stringify(await alice.get(`/v1/client/projects/${project.body.projectId}/keys`)))
      .not.toContain(readOnly.body.apiKey);
    const readAuth = { Authorization: `Bearer ${readOnly.body.apiKey}` };
    expect((await request(app).get(`/v1/data/items/${inserted.body.id}`).set(readAuth)).status).toBe(200);
    expect((await request(app).get("/v1/projects").set(readAuth)).status).toBe(401);
    expect((await request(app).post("/v1/data").set(readAuth).send({
      collection: "items", data: { name: "blocked" },
    })).status).toBe(403);
    expect((await request(app).get(`/v1/project?projectId=${project.body.projectId}`).set({
      Authorization: `Bearer ${readOnly.body.apiKey}`,
      "X-Project-Id": "proj_000000000000",
    })).status).toBe(403);

    expect((await alice.delete(`/v1/client/projects/${project.body.projectId}/keys/${readOnly.body.keyId}`)).status).toBe(200);
    expect((await request(app).get("/v1/project").set(readAuth)).status).toBe(401);
    expect((await alice.post(`/v1/client/projects/${project.body.projectId}/keys`).send({
      scopes: ["operator:admin"],
    })).status).toBe(400);
  });
});
