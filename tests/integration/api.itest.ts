/**
 * API integration — the app's real Hono router, in-process via app.request().
 *
 * Focus on the security-relevant behaviour: unauthenticated requests are
 * refused, and one customer can never read or act on another's application
 * (IDOR). These are the failures that matter most in a lending product and are
 * exactly what a hand test tends to miss.
 */

import { describe, expect, it } from "vitest";
import { app } from "../../apps/api/src/app.js";
import { createSession } from "../../apps/api/src/auth.js";
import { prisma } from "./db.js";
import { makeApplication, makeCustomer } from "./factory.js";

async function tokenFor(customerId: string): Promise<string> {
  const { token } = await createSession(customerId);
  return token;
}

function authed(token: string, body?: unknown): RequestInit {
  return {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
}

describe("API auth", () => {
  it("refuses an unauthenticated request", async () => {
    const res = await app.request("/applications");
    expect(res.status).toBe(401);
  });

  it("refuses a bad token", async () => {
    const res = await app.request("/applications", authed("not-a-real-token"));
    expect(res.status).toBe(401);
  });

  it("lets a customer read their own application", async () => {
    const application = await makeApplication();
    const token = await tokenFor(application.customerId!);

    const res = await app.request(`/applications/${application.id}`, authed(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(application.id);
  });

  it("does NOT let one customer read another's application (IDOR)", async () => {
    const victim = await makeApplication();
    const attacker = await makeApplication();
    const attackerToken = await tokenFor(attacker.customerId!);

    // Attacker knows the victim's application id and asks for it directly.
    const res = await app.request(`/applications/${victim.id}`, authed(attackerToken));
    expect(res.status).toBe(404); // scoped by customerId -> not found, not leaked
  });

  it("returns 409 (not 500) when submitting a lead that hasn't been claimed... from the wrong state", async () => {
    // A DRAFT (not a LEAD) can't be submitted; well-formed request, wrong state.
    const application = await makeApplication({ status: "DRAFT" });
    const token = await tokenFor(application.customerId!);

    const res = await app.request(
      `/applications/${application.id}/submit`,
      authed(token, {}),
    );
    expect(res.status).toBe(409);
  });

  it("rejects a malformed application body with 400", async () => {
    const application = await makeApplication();
    const token = await tokenFor(application.customerId!);

    const res = await app.request(
      "/applications",
      authed(token, { requestedTermMonths: 3 }), // below the min of 6
    );
    expect(res.status).toBe(400);
  });
});

describe("anonymous quiz + claim (the split)", () => {
  /** Create an anonymous draft the way the website does — no auth. */
  async function startDraft(): Promise<{ id: string; draftToken: string }> {
    const res = await app.request("/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedTermMonths: 48 }),
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  function draftReq(draftToken: string, body?: unknown): RequestInit {
    return {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "x-draft-token": draftToken,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
  }

  it("creates a draft anonymously and returns a capability token", async () => {
    const { id, draftToken } = await startDraft();
    expect(id).toBeTruthy();
    expect(draftToken).toBeTruthy();
  });

  it("refuses a draft mutation without the token", async () => {
    const { id } = await startDraft();
    const res = await app.request(`/applications/${id}/statements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileRef: "resurs-bank__x.jpg" }),
    });
    expect(res.status).toBe(401); // missing draft token
  });

  it("refuses a draft mutation with the WRONG token", async () => {
    const { id } = await startDraft();
    const res = await app.request(
      `/applications/${id}/statements`,
      draftReq("not-the-right-token", { fileRef: "resurs-bank__x.jpg" }),
    );
    expect(res.status).toBe(403);
  });

  it("accepts a draft mutation with the correct token", async () => {
    const { id, draftToken } = await startDraft();
    const res = await app.request(
      `/applications/${id}/statements`,
      draftReq(draftToken, { fileRef: "resurs-bank__x.jpg" }),
    );
    expect(res.status).toBe(201);
  });

  it("binds a captured lead to the verified customer on claim, one-time", async () => {
    // Seed a lead directly (OCR/KALP already done), with a claim token.
    const customer = await makeCustomer();
    const lead = await prisma.loanApplication.create({
      data: {
        status: "LEAD",
        requestedTermMonths: 48,
        correlationId: "itest-claim",
        claimToken: "claim-abc",
        contactEmail: "lead@example.com",
        existingBalanceMinor: 4_500_000,
        existingAprBps: 2_495,
      },
    });
    const token = await tokenFor(customer.id);

    const first = await app.request(
      "/applications/claim",
      authed(token, { claimToken: "claim-abc" }),
    );
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.id).toBe(lead.id);

    // Now owned by the customer...
    const owned = await prisma.loanApplication.findUniqueOrThrow({ where: { id: lead.id } });
    expect(owned.customerId).toBe(customer.id);
    expect(owned.claimToken).toBeNull(); // retired

    // ...and the one-time token can't be replayed.
    const replay = await app.request(
      "/applications/claim",
      authed(token, { claimToken: "claim-abc" }),
    );
    expect(replay.status).toBe(404);
  });
});

describe("ops guard", () => {
  it("is open when OPS_TOKEN is unset (demo mode)", async () => {
    delete process.env.OPS_TOKEN;
    const res = await app.request("/ops/queues");
    expect(res.status).toBe(200);
  });

  it("forbids ops access without the token once OPS_TOKEN is set", async () => {
    process.env.OPS_TOKEN = "s3cret";
    try {
      const res = await app.request("/ops/queues");
      expect(res.status).toBe(403);

      const withToken = await app.request("/ops/queues", {
        headers: { "x-ops-token": "s3cret" },
      });
      expect(withToken.status).toBe(200);

      const wrong = await app.request("/ops/queues", {
        headers: { "x-ops-token": "wrong" },
      });
      expect(wrong.status).toBe(403);
    } finally {
      delete process.env.OPS_TOKEN;
    }
  });
});
