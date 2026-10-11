import assert from "node:assert/strict";
import test from "node:test";

import { guardSetTypeOfService } from "../src/socket-tos-guard.js";

function failingSocketType(error) {
  const calls = [];
  const proto = {
    setTypeOfService(tos) {
      calls.push({ self: this, tos });
      throw error;
    },
  };
  return { proto, calls };
}

function errnoError(code) {
  return Object.assign(new Error(`setTypeOfService ${code}`), { code, syscall: "setTypeOfService" });
}

test("a guarded setTypeOfService turns EINVAL into a no-op that still returns the socket", () => {
  const { proto, calls } = failingSocketType(errnoError("EINVAL"));
  guardSetTypeOfService(proto);
  const socket = Object.create(proto);

  assert.equal(socket.setTypeOfService(0), socket);
  assert.deepEqual(calls, [{ self: socket, tos: 0 }]);
});

test("a guarded setTypeOfService still throws every error other than EINVAL", () => {
  for (const error of [errnoError("EBADF"), Object.assign(new RangeError("tos"), { code: "ERR_OUT_OF_RANGE" })]) {
    const { proto } = failingSocketType(error);
    guardSetTypeOfService(proto);

    assert.throws(
      () => Object.create(proto).setTypeOfService(256),
      (thrown) => thrown === error,
    );
  }
});

test("a guarded setTypeOfService passes a successful call through", () => {
  const proto = {
    setTypeOfService(tos) {
      this.tos = tos;
      return this;
    },
  };
  guardSetTypeOfService(proto);
  const socket = Object.create(proto);

  assert.equal(socket.setTypeOfService(8), socket);
  assert.equal(socket.tos, 8);
});

// Node 22's sockets have no setTypeOfService, and its undici never asks for one.
test("the guard gives a socket type without setTypeOfService none", () => {
  const proto = {};
  guardSetTypeOfService(proto);

  assert.equal("setTypeOfService" in proto, false);
});

// `run()` installs the guard, and tests call `run()` many times in one process.
test("guarding twice wraps setTypeOfService once", () => {
  const { proto } = failingSocketType(errnoError("EINVAL"));
  guardSetTypeOfService(proto);
  const guarded = proto.setTypeOfService;
  guardSetTypeOfService(proto);

  assert.equal(proto.setTypeOfService, guarded);
});
