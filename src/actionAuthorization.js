import crypto from "crypto";

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(secret, encodedPayload) {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function equalSignature(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function issueActionAuthorization({
  secret,
  operation,
  details,
  ttlSeconds = 300,
  now = new Date(),
}) {
  if (!secret) throw new Error("authorization_signing_secret_required");
  if (!operation) throw new Error("authorization_operation_required");
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 900) {
    throw new Error("authorization_ttl_out_of_range");
  }

  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = {
    version: 1,
    operation,
    details,
    issued_at: issuedAt,
    expires_at: issuedAt + ttlSeconds,
    nonce: crypto.randomUUID(),
  };
  const encodedPayload = encodeJson(payload);
  return {
    token: `${encodedPayload}.${sign(secret, encodedPayload)}`,
    payload,
  };
}

export function verifyActionAuthorization({ secret, token, operation, now = new Date() }) {
  if (!secret) throw new Error("authorization_signing_secret_required");
  const [encodedPayload, providedSignature, extra] = String(token || "").split(".");
  if (!encodedPayload || !providedSignature || extra) {
    throw new Error("authorization_token_invalid");
  }

  const expectedSignature = sign(secret, encodedPayload);
  if (!equalSignature(providedSignature, expectedSignature)) {
    throw new Error("authorization_token_invalid");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("authorization_token_invalid");
  }

  if (payload.version !== 1 || payload.operation !== operation || !payload.nonce) {
    throw new Error("authorization_token_scope_mismatch");
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(payload.expires_at) || nowSeconds >= payload.expires_at) {
    throw new Error("authorization_token_expired");
  }

  return payload;
}

export function createAuthorizationConsumer({ secret, now = () => new Date() }) {
  const consumedNonces = new Map();

  function prune(currentSeconds) {
    for (const [nonce, expiresAt] of consumedNonces) {
      if (expiresAt <= currentSeconds) consumedNonces.delete(nonce);
    }
  }

  return function consume({ token, operation }) {
    const current = now();
    const payload = verifyActionAuthorization({ secret, token, operation, now: current });
    const currentSeconds = Math.floor(current.getTime() / 1000);
    prune(currentSeconds);

    if (consumedNonces.has(payload.nonce)) {
      throw new Error("authorization_token_already_used");
    }

    consumedNonces.set(payload.nonce, payload.expires_at);
    return payload;
  };
}
