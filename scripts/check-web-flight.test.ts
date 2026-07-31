import { existsSync } from "fs";
import { describe, expect, it } from "bun:test";
import { startLocalGzipServer } from "./check-web-flight.js";

describe("web flight local server", () => {
  it("isolates concurrent server sockets and cleans them up", async () => {
    const [first, second] = await Promise.all([
      startLocalGzipServer(),
      startLocalGzipServer(),
    ]);

    try {
      expect(first.socketPath).not.toBe(second.socketPath);

      const [firstResponse, secondResponse] = await Promise.all([
        fetch("http://localhost/index.html", { unix: first.socketPath }),
        fetch("http://localhost/index.html", { unix: second.socketPath }),
      ]);

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(firstResponse.headers.get("content-encoding")).toBe("gzip");
      expect(secondResponse.headers.get("content-encoding")).toBe("gzip");
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }

    expect(existsSync(first.socketPath)).toBe(false);
    expect(existsSync(second.socketPath)).toBe(false);
  });
});
