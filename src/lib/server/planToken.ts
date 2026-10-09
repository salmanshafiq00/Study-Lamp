import crypto from "crypto";

export type PlanScope = "calendar" | "tasks" | "docs_append" | "sheets_append" | "remove";

export type PlanTokenItem = { itemId: string; fingerprint: string };

export interface SignPlanTokenInput {
  uid: string;
  scope: PlanScope;
  items: PlanTokenItem[];
  exp?: number;
}

export interface VerifiedPlanToken {
  uid: string;
  scope: PlanScope;
  items: PlanTokenItem[];
  exp: number;
  /** Random one-time id (16 bytes, base64url). Used by markTokenUsed to reject replays. */
  jti: string;
}

export class PlanTokenVerificationError extends Error {
  readonly code: "expired" | "tampered" | "wrong_user" | "wrong_scope";

  constructor(code: PlanTokenVerificationError["code"], message: string) {
    super(message);
    this.name = "PlanTokenVerificationError";
    this.code = code;
  }
}

const PLAN_TOKEN_PREFIX = "sync-plan.v1|";
const PLAN_SCOPES: readonly PlanScope[] = ["calendar", "tasks", "docs_append", "sheets_append", "remove"];

/**
 * The HMAC key for plan tokens. PREFERRED: a dedicated GOOGLE_SYNC_SIGNING_SECRET, so a leaked Drive URL secret can
 * never be used to forge a plan token (audit M5). FALLBACK: DRIVE_URL_SIGNING_SECRET, kept so existing deployments
 * keep working without a new variable; it still cannot be confused with a Drive URL because every plan token is
 * signed over the "sync-plan.v1|" prefix. An empty value counts as unset.
 */
export function planTokenSecretSource(env: Record<string, string | undefined> = process.env): "GOOGLE_SYNC_SIGNING_SECRET" | "DRIVE_URL_SIGNING_SECRET" | null {
  if (env.GOOGLE_SYNC_SIGNING_SECRET) return "GOOGLE_SYNC_SIGNING_SECRET";
  if (env.DRIVE_URL_SIGNING_SECRET) return "DRIVE_URL_SIGNING_SECRET";
  return null;
}

function signingSecret(): string {
  const source = planTokenSecretSource();
  if (!source) throw new Error("No signing secret configured for sync plan tokens.");
  return process.env[source] as string;
}

function signatureForPayload(body: string): string {
  return crypto.createHmac("sha256", signingSecret()).update(`${PLAN_TOKEN_PREFIX}${body}`).digest("base64url");
}

export function signPlanToken(input: SignPlanTokenInput, nowMs = Date.now()): string {
  if (!input.uid) throw new Error("Plan token requires a user id.");
  if (!PLAN_SCOPES.includes(input.scope)) throw new Error(`Unsupported plan scope: ${input.scope}`);
  if (!Array.isArray(input.items)) throw new Error("Plan token items must be an array.");

  const exp = Number.isInteger(input.exp) ? input.exp! : Math.floor(nowMs / 1000) + 15 * 60;
  const payload: VerifiedPlanToken = {
    uid: input.uid,
    scope: input.scope,
    items: input.items.map((item) => ({ itemId: item.itemId, fingerprint: item.fingerprint })),
    exp,
    jti: crypto.randomBytes(16).toString("base64url"),
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = signatureForPayload(body);
  return `${body}.${sig}`;
}

export function verifyPlanToken(token: string, expectedUser?: string, expectedScope?: PlanScope, nowMs = Date.now()): VerifiedPlanToken {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new PlanTokenVerificationError("tampered", "Plan token is malformed.");

  const expectedSig = signatureForPayload(body);
  const supplied = Buffer.from(sig, "base64url");
  const expected = Buffer.from(expectedSig, "base64url");

  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new PlanTokenVerificationError("tampered", "Plan token signature is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new PlanTokenVerificationError("tampered", "Plan token payload is invalid.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new PlanTokenVerificationError("tampered", "Plan token payload is invalid.");
  }

  const payload = parsed as Partial<VerifiedPlanToken>;
  if (typeof payload.uid !== "string" || !PLAN_SCOPES.includes(payload.scope as PlanScope)) {
    throw new PlanTokenVerificationError("tampered", "Plan token payload is invalid.");
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds) {
    throw new PlanTokenVerificationError("expired", "Plan token has expired.");
  }
  const exp: number = payload.exp;

  if (expectedUser && payload.uid !== expectedUser) {
    throw new PlanTokenVerificationError("wrong_user", "Plan token belongs to a different user.");
  }

  if (expectedScope && payload.scope !== expectedScope) {
    throw new PlanTokenVerificationError("wrong_scope", "Plan token was issued for a different scope.");
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const validItems = items.filter((item) => typeof item?.itemId === "string" && typeof item?.fingerprint === "string");
  if (validItems.length !== items.length) {
    throw new PlanTokenVerificationError("tampered", "Plan token item list is invalid.");
  }

  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new PlanTokenVerificationError("tampered", "Plan token is missing its one-time id.");
  }

  return {
    uid: payload.uid,
    scope: payload.scope as PlanScope,
    items: validItems,
    exp,
    jti: payload.jti,
  };
}
