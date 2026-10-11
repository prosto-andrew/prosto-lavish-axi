import net from "node:net";

const GUARDED = Symbol.for("lavish-axi.set-type-of-service-guard");

/**
 * Node 24's bundled undici (7.x) calls `socket.setTypeOfService(0)` before writing every HTTP/1
 * request, with no try/catch, from the socket's `connect` handler. macOS answers EINVAL once the
 * server has reset the just-accepted connection (it was closing), and the throw escapes every
 * `fetch()` catch as an uncaughtException: `lavish-safe stop` died before its /shutdown request
 * was written. Swallowing exactly EINVAL lets that request fail the ordinary way, on the reset
 * socket. Fixed upstream in undici 8.8.0 (nodejs/undici#5547, Node 26.5.1+); drop this once the
 * undici bundled in the supported Node lines no longer makes the call unguarded.
 * @param {object} [proto]
 */
export function guardSetTypeOfService(proto = net.Socket.prototype) {
  const original = proto.setTypeOfService;
  if (typeof original !== "function" || original[GUARDED]) return;
  const guarded = function setTypeOfService(tos) {
    try {
      return original.call(this, tos);
    } catch (error) {
      if (error?.code === "EINVAL") return this;
      throw error;
    }
  };
  guarded[GUARDED] = true;
  proto.setTypeOfService = guarded;
}
