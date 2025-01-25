import type { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import request from "supertest";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

let httpAdapter!: BunHttpAdapter;
let app!: Parameters<typeof request>[0];

beforeAll(async () => {
  httpAdapter = new BunHttpAdapter(30000, {
    router: {
      debug: false,
    },
  });
  httpAdapter.registerParserMiddleware(undefined, true); // Register body parsing middleware
  httpAdapter.post("/test", async (req, res) => {
    return res.json(req.body as Record<string, unknown>);
  });

  httpAdapter.get("/api/v1/users", (req, res) => {
    return res.status(200).json({ message: "List of users" });
  });

  httpAdapter.post("/api/v1/users", (req, res) => {
    const user = req.body;
    return res.status(201).json({ message: "User created", user });
  });

  httpAdapter.get("/api/v1/users/:id(\\d+)", (req, res) => {
    res.status(200).json({ message: `User details for ID: ${req.params.id}` });
  });

  httpAdapter.put("/api/v1/users/:id(\\d+)", (req, res) => {
    const { id } = req.params;
    const updatedData = req.body;
    res.status(200).json({ message: `User ${id} updated`, updatedData });
  });

  httpAdapter.delete("/api/v1/users/:id(\\d+)", (req, res) => {
    res.status(200).json({ message: `User ${req.params.id} deleted` });
  });

  httpAdapter.get("/api/v1/users/:id(\\d+)/posts", (req, res) => {
    res.status(200).json({ message: `Posts for user ${req.params.id}` });
  });

  httpAdapter.get("/api/v1/admin(/settings)?", (req, res) => {
    if (req.path.endsWith("settings")) {
      res.status(200).json({ message: "Admin settings" });
    } else {
      res.status(200).json({ message: "Admin dashboard" });
    }
  });

  const fileNameKeyRegexpStr = `[a-zA-Z0-9_-]+\\.`;
  httpAdapter.get(
    `/api/v1/files/:filename(${fileNameKeyRegexpStr}jpg|${fileNameKeyRegexpStr}gif|${fileNameKeyRegexpStr}webp)`,
    (req, res) => {
      res.status(200).json({ message: `File: ${req.params.filename}` });
    },
  );

  httpAdapter.get("/api/v1/search/:query(.*)", (req, res) => {
    res
      .status(200)
      .json({ message: `Search results for: ${req.params.query}` });
  });

  httpAdapter.get("/api/v1/users/:other(.*)", (req, res) => {
    res.status(404).json({ message: "Catch all for USERS API endpoint" });
  });

  httpAdapter.setNotFoundHandler((req, res) => {
    res.status(404).json({ message: "Route not found" });
  });

  await httpAdapter.listen(10000);

  app = httpAdapter as unknown as App;
});

afterAll(async () => {
  await httpAdapter?.close();
});

describe("Http Adapter Routing - Complex Paths", () => {
  it("gET /api/v1/users - List of users", async () => {
    const response = await request(app)
      .get("/api/v1/users")
      .set("Accept", "application/json");

    expect(response.status).toEqual(200);
    expect(response.body).toEqual({ message: "List of users" });
  });

  it("pOST /api/v1/users - Create a user", async () => {
    const newUser = { name: "John", email: "john@example.com" };
    const response = await request(app)
      .post("/api/v1/users")
      .send(newUser)
      .set("Content-Type", "application/json");
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ message: "User created", user: newUser });
  });

  it("gET /api/v1/users/:id - Valid user ID", async () => {
    const response = await request(app).get("/api/v1/users/123");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "User details for ID: 123" });
  });

  it("gET /api/v1/users/:id - Invalid user ID (non-numeric)", async () => {
    const response = await request(app).get("/api/v1/users/abc");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      message: "Catch all for USERS API endpoint",
    });
  });

  it("pUT /api/v1/users/:id - Update user", async () => {
    const updatedData = { name: "Jane", email: "jane@example.com" };
    const response = await request(app)
      .put("/api/v1/users/456")
      .send(updatedData)
      .set("Content-Type", "application/json");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: "User 456 updated",
      updatedData,
    });
  });

  it("dELETE /api/v1/users/:id - Delete user", async () => {
    const response = await request(app).delete("/api/v1/users/789");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "User 789 deleted" });
  });

  it("gET /api/v1/users/:id/posts - User posts", async () => {
    const response = await request(app).get("/api/v1/users/123/posts");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Posts for user 123" });
  });

  it("gET /api/v1/admin - Admin dashboard", async () => {
    const response = await request(app).get("/api/v1/admin");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Admin dashboard" });
  });

  it("gET /api/v1/admin/settings - Admin settings", async () => {
    const response = await request(app).get("/api/v1/admin/settings");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Admin settings" });
  });

  it("gET /api/v1/files/:filename - Valid filename with webp", async () => {
    const response = await request(app).get("/api/v1/files/image.webp");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "File: image.webp" });
  });

  it("gET /api/v1/files/:filename - Valid filename with gif", async () => {
    const response = await request(app).get("/api/v1/files/image.gif");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "File: image.gif" });
  });

  it("gET /api/v1/files/:filename - Valid filename with jpg", async () => {
    const response = await request(app).get("/api/v1/files/image.jpg");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "File: image.jpg" });
  });

  it("gET /api/v1/files/:filename - Invalid filename", async () => {
    const response = await request(app).get("/api/v1/files/men/image.jpg");
    expect(response.status).toBe(404);
  });

  it("gET /api/v1/files/:filename - Invalid filename", async () => {
    const response = await request(app).get("/api/v1/files/image.pdf");
    expect(response.status).toBe(404);
  });

  it("gET /api/v1/search/:query - Search with query", async () => {
    const query = "example+query";
    const response = await request(app).get(`/api/v1/search/${query}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: `Search results for: ${query}` });
  });

  it("gET /api/v1/search/ - Search with empty query", async () => {
    const response = await request(app).get("/api/v1/search/");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Search results for: " });
  });

  it("gET /nonexistent - Undefined route", async () => {
    const response = await request(app).get("/nonexistent");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Route not found" });
  });

  // Add more cases as needed for edge conditions.
});
