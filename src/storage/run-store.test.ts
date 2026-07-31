import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { afterEach, describe, expect, it } from "bun:test";
import { loadRun } from "./run-store.js";

const TEST_RUN_ID = `run-store-test-${randomUUID()}`;
const TEST_RUN_DIR = join(process.cwd(), "data", "runs", TEST_RUN_ID);

describe("run storage validation", () => {
  afterEach(async () => {
    if (existsSync(TEST_RUN_DIR)) {
      await rm(TEST_RUN_DIR, { recursive: true });
    }
  });

  it("rejects a persisted ID that does not match its directory", async () => {
    await mkdir(TEST_RUN_DIR, { recursive: true });
    await writeFile(join(TEST_RUN_DIR, "run.json"), JSON.stringify({
      config: {
        id: "different-run-id",
        timestamp: "2026-07-31T00:00:00.000Z",
      },
      meta: { totalCost: 0 },
      samples: [],
      feedback: [],
      judgments: [],
    }));

    await expect(loadRun(TEST_RUN_ID)).rejects.toThrow(
      `config.id does not match directory ${TEST_RUN_ID}`,
    );
  });
});
