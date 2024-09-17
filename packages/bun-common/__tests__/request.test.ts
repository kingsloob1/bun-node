import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { get } from "lodash-es";
import urlJoin from "url-join";
import type { Server } from "bun";
import { BunHttpAdapter } from "../../bun-nest/lib/BunHttpAdapter";
import { BunRequest } from "../lib";
import { transformUploadOptions } from "../lib/multipart";
import { handleMultipartAnyFiles } from "../lib/multipart/handlers";
import type { RouterMiddlewareHandler } from "../lib";

let httpAdapter!: BunHttpAdapter;
beforeAll(async () => {
  httpAdapter = new BunHttpAdapter(30000);
  httpAdapter.registerParserMiddleware(undefined, true); // Register body parsing middleware

  const handler: RouterMiddlewareHandler = async (req, res) => {
    return res.json(req.body as Record<string, unknown>);
  };

  httpAdapter.instance.post("/test", handler);
  await httpAdapter.listen(10000);
});

afterAll(() => {
  httpAdapter.close();
});

const buildUrl = (path: string, adapter: BunHttpAdapter = httpAdapter) => {
  const host = adapter.listeningHost;
  const port = adapter.listeningPort || 80;

  return urlJoin(`http://${host}:${port}`, path);
};

describe("Test Bun Request", () => {
  it("Should be able to initialize request", () => {
    expect(
      new BunRequest(
        new Request("https://google.com"),
        httpAdapter.getBunServer() as Server,
      ),
    ).toBeInstanceOf(BunRequest);
  });

  describe("Request body parsing with Content-Type Header", () => {
    it("should parse JSON body", async () => {
      const url = buildUrl("/test");
      const headers = new Headers();
      headers.set("Content-Type", "application/json");

      const response = await fetch(url, {
        headers,
        method: "POST",
        body: JSON.stringify({
          key: "value",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ key: "value" });
    });

    it("should parse URL-encoded body", async () => {
      const url = buildUrl("/test");
      const headers = new Headers();
      headers.set("Content-Type", "application/x-www-form-urlencoded");

      const response = await fetch(url, {
        headers,
        method: "POST",
        body: "key=value",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ key: "value" });
    });

    it("should parse plain text body", async () => {
      const url = buildUrl("/test");
      const headers = new Headers();
      headers.set("Content-Type", "text/plain");

      const response = await fetch(url, {
        headers,
        method: "POST",
        body: "key=value",
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toEqual(JSON.stringify("key=value"));
    });

    it("should parse raw body", async () => {
      const rawData = Buffer.from([0x01, 0x02, 0x03]);
      const httpAdapter = new BunHttpAdapter(30000);
      httpAdapter.registerParserMiddleware(undefined, true); // Register body parsing middleware

      const handler: RouterMiddlewareHandler = async (req, res) => {
        return res.send(req.body?.toString());
      };

      httpAdapter.instance.post("/test", handler);
      await httpAdapter.listen(10000);

      const url = buildUrl("/test", httpAdapter);
      const headers = new Headers();
      headers.set("Content-Type", "application/octet-stream");

      const response = await fetch(url, {
        headers,
        method: "POST",
        body: rawData,
      });

      try {
        expect(response.status).toBe(200);
        const bodyBuffer = Buffer.from(await response.arrayBuffer());
        expect(bodyBuffer).toBeInstanceOf(Buffer);
        expect(Buffer.compare(bodyBuffer, rawData)).toBe(0);
      } finally {
        await httpAdapter.close();
      }
    });

    it("should auto parse multipart form data body", async () => {
      const httpAdapter = new BunHttpAdapter(30000);
      await httpAdapter.listen(10000);
      httpAdapter.registerParserMiddleware(undefined, true); // Register body parsing middleware

      // Add middleware to handle file upload based on options
      const globalParseMultipartFormDataHandler: RouterMiddlewareHandler =
        async (req, res, next) => {
          try {
            const { files, body } = await handleMultipartAnyFiles(
              req,
              transformUploadOptions({
                storageType: "memory",
              }),
            );

            req.setStorageFiles(files);
            req.body = body;
            next();
          } catch (e) {
            console.log("Error in parsing files =====> ", e);
            throw e;
          }
        };

      httpAdapter.use(globalParseMultipartFormDataHandler);

      const handler: RouterMiddlewareHandler = async (req, res) => {
        return res.json({
          files: req.files,
          body: req.body,
        });
      };

      httpAdapter.instance.post("/test", handler);
      const url = buildUrl("/test", httpAdapter);

      const blob1 = new Blob(["hello1"]);
      const blob2 = new Blob(["hello2"]);
      const formData = new FormData();

      const jsonData = {
        key: "values",
        boy: "man",
      };
      formData.set("blob1", blob1);
      formData.set("blob2", blob2);

      formData.append("name", "0");
      formData.append("name", "1");
      formData.append("name", "2");
      formData.append("name", "3");
      formData.append("name", "4");
      formData.append("name[boy][men]", "boy-men");
      formData.set("urlencoded[0]", "0");
      formData.set("urlencoded[1]", "1");
      formData.set("urlencoded[eggs]", "egger");
      formData.set("json", JSON.stringify(jsonData));

      const response = await fetch(url, {
        method: "POST",
        body: formData,
      });

      try {
        expect(response.status).toBe(200);

        const jsonResp = await response.json();
        expect(jsonResp).toBeObject();
        expect(jsonResp).toContainAllKeys(["files", "body"]);

        const files = get(jsonResp, "files");
        expect(files).toBeArray();
        expect(files).toBeArrayOfSize(2);
        expect(files).toSatisfy((files) => {
          return files.every((file) => {
            return ["blob1", "blob2"].includes(get(file, "fieldname", ""));
          });
        });

        const body = get(jsonResp, "body");
        expect(body).toBeObject();
      } finally {
        await httpAdapter.close();
      }
    });
  });

  describe("Auto Request body parsing without Content-Type Header", () => {
    it("should auto parse JSON body", async () => {
      const url = buildUrl("/test");
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify({
          key: "value",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ key: "value" });
    });

    it("should auto parse URL-encoded body", async () => {
      const url = buildUrl("/test");
      const response = await fetch(url, {
        method: "POST",
        body: "key=value",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ key: "value" });
    });
  });
});
