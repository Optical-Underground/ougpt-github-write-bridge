import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthorizationConsumer,
  issueActionAuthorization,
  verifyActionAuthorization,
} from "../src/actionAuthorization.js";

const SECRET = "test-signing-secret";
const NOW = new Date("2026-08-07T20:00:00Z");

test("issues and verifies an operation-scoped short-lived authorization", () => {
  const issued = issueActionAuthorization({
    secret: SECRET,
    operation: "merge",
    details: { repo: "Optical-Underground/example", pr_number: 12 },
    ttlSeconds: 300,
    now: NOW,
  });

  const payload = verifyActionAuthorization({
    secret: SECRET,
    token: issued.token,
    operation: "merge",
    now: new Date("2026-08-07T20:04:59Z"),
  });

  assert.equal(payload.operation, "merge");
  assert.equal(payload.details.pr_number, 12);
  assert.equal(payload.expires_at - payload.issued_at, 300);
});

test("rejects tampered, expired, and wrong-operation authorizations", () => {
  const issued = issueActionAuthorization({
    secret: SECRET,
    operation: "deploy",
    details: { expected_merge_commit: "merge-sha" },
    ttlSeconds: 60,
    now: NOW,
  });
  const [payload, signature] = issued.token.split(".");
  const tampered = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${signature}`;

  assert.throws(
    () =>
      verifyActionAuthorization({
        secret: SECRET,
        token: tampered,
        operation: "deploy",
        now: NOW,
      }),
    /authorization_token_invalid/
  );
  assert.throws(
    () =>
      verifyActionAuthorization({
        secret: SECRET,
        token: issued.token,
        operation: "merge",
        now: NOW,
      }),
    /authorization_token_scope_mismatch/
  );
  assert.throws(
    () =>
      verifyActionAuthorization({
        secret: SECRET,
        token: issued.token,
        operation: "deploy",
        now: new Date("2026-08-07T20:01:00Z"),
      }),
    /authorization_token_expired/
  );
});

test("consumes an authorization nonce only once", () => {
  const issued = issueActionAuthorization({
    secret: SECRET,
    operation: "merge",
    details: { pr_number: 12 },
    ttlSeconds: 300,
    now: NOW,
  });
  const consume = createAuthorizationConsumer({ secret: SECRET, now: () => NOW });

  assert.equal(consume({ token: issued.token, operation: "merge" }).details.pr_number, 12);
  assert.throws(
    () => consume({ token: issued.token, operation: "merge" }),
    /authorization_token_already_used/
  );
});

test("rejects authorization TTLs above the fifteen-minute safety ceiling", () => {
  assert.throws(
    () =>
      issueActionAuthorization({
        secret: SECRET,
        operation: "merge",
        details: {},
        ttlSeconds: 901,
        now: NOW,
      }),
    /authorization_ttl_out_of_range/
  );
});
