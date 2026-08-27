import type { Socket } from "node:net";

/** pi-intercom wire format: 4-byte big-endian length + JSON payload. */
export function writeMessage(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payloadLength = Buffer.byteLength(json, "utf-8");
  const frame = Buffer.allocUnsafe(4 + payloadLength);
  frame.writeUInt32BE(payloadLength, 0);
  frame.write(json, 4, payloadLength);
  socket.write(frame);
}

/** Incremental reader; calls onMessage per complete frame. */
export function createMessageReader(
  onMessage: (msg: unknown) => void,
  onError: (err: Error) => void,
  maxFrameBytes = 1024 * 1024,
): (data: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (data: Buffer) => {
    buf = Buffer.concat([buf, data]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > maxFrameBytes) {
        onError(new Error(`frame too large: ${len}`));
        return;
      }
      if (buf.length < 4 + len) return;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        onMessage(JSON.parse(payload.toString("utf-8")));
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };
}
