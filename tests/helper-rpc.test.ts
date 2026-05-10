import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FaceTimeHelperSocketServer } from "../src/helper-rpc.js";

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve TCP port");
  }
  return address.port;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("FaceTime helper RPC", () => {
  let helper: FaceTimeHelperSocketServer | undefined;
  let client: net.Socket | undefined;

  afterEach(async () => {
    client?.destroy();
    await helper?.stop();
    client = undefined;
    helper = undefined;
  });

  it("sends set-muted actions over newline-framed JSON and resolves acknowledgements", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await waitFor(() => helper?.connectedSockets === 1);

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });

    const actionPromise = helper.setMuted("call-1", false);
    const payload = await received;
    expect(payload).toMatchObject({
      action: "set-muted",
      data: { callUUID: "call-1", muted: false },
    });
    expect(typeof payload.transactionId).toBe("string");

    client.write(`${JSON.stringify({ transactionId: payload.transactionId })}\r\n`);
    await expect(actionPromise).resolves.toBeUndefined();
  });
});
