/**
 * Application routes — split into two phases: an anonymous lead funnel and an
 * authenticated app.
 *
 *   quizRoutes  — the ANONYMOUS web funnel. No BankID, no session. A draft is
 *                 authorised by a capability token (x-draft-token). Collects a
 *                 lead: lender, statements, KALP, contact. Nothing is assessed.
 *
 *   appRoutes   — the AUTHENTICATED app. BankID has produced a session; the
 *                 customer CLAIMS their lead, then submits for assessment. This
 *                 is the only phase that touches the credit bureau.
 *
 * Both mount under /applications. The split is the design: identity is required
 * only when we act on the data, never to collect it.
 *
 * Every handler stays thin: validate -> write state -> (enqueue) -> return.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  BEST_EFFORT_JOB_OPTS,
  DURABLE_JOB_OPTS,
  QUEUE,
  claimSchema,
  contactSchema,
  createApplicationSchema,
  kalpAnswersSchema,
  toJobId,
  uploadStatementSchema,
  type ApplicationStatus,
} from "@refi/domain";
import { decryptPii, prisma, transitionApplication } from "@refi/db";
import { requireAuth, requireDraft, type AuthEnv, type DraftEnv } from "../auth.js";
import { flowProducer, queue } from "../queues.js";

function token(): string {
  return randomBytes(32).toString("base64url");
}

function kalpComplete(a: {
  ownsAccommodation: boolean | null;
  hasSpouse: boolean | null;
  numberOfChildren: number | null;
  monthlyIncomeGrossMinor: number | null;
  incomeSource: string | null;
  monthlyDebtPaymentMinor: number | null;
}): boolean {
  return (
    a.ownsAccommodation !== null &&
    a.hasSpouse !== null &&
    a.numberOfChildren !== null &&
    a.monthlyIncomeGrossMinor !== null &&
    a.incomeSource !== null &&
    a.monthlyDebtPaymentMinor !== null
  );
}

// ===========================================================================
// Phase 1 — anonymous web quiz
// ===========================================================================

export const quizRoutes = new Hono<DraftEnv>();

/**
 * Start an anonymous application.
 *
 * No auth: this is the top of the funnel. Returns a `draftToken` the client
 * must present for every later quiz mutation — the capability that stands in
 * for a session before there is a customer.
 */
quizRoutes.post("/", zValidator("json", createApplicationSchema), async (c) => {
  const { requestedTermMonths } = c.req.valid("json");
  const draftToken = token();

  const application = await prisma.loanApplication.create({
    data: {
      status: "DRAFT",
      requestedTermMonths,
      draftToken,
      correlationId: randomUUID(),
    },
  });

  await prisma.applicationEvent.create({
    data: {
      applicationId: application.id,
      toStatus: "DRAFT",
      reason: "Anonymous quiz started",
      correlationId: application.correlationId,
    },
  });

  return c.json({ id: application.id, draftToken }, 201);
});

/** Draft view for polling OCR during the quiz. Authorised by the draft token. */
quizRoutes.get("/:id/draft", requireDraft, async (c) => {
  const application = await prisma.loanApplication.findUnique({
    where: { id: c.get("applicationId") },
    include: {
      statements: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!application) return c.json({ error: "Not found" }, 404);

  // Never leak the tokens back to the client beyond what it already holds.
  const { draftToken: _d, claimToken: _c, ...safe } = application;
  return c.json(safe);
});

/** Add a statement to the cart. */
quizRoutes.post(
  "/:id/statements",
  requireDraft,
  zValidator("json", uploadStatementSchema),
  async (c) => {
    const applicationId = c.get("applicationId");
    const { fileRef } = c.req.valid("json");

    const application = await prisma.loanApplication.findUniqueOrThrow({
      where: { id: applicationId },
    });
    const status = application.status as ApplicationStatus;
    if (!["DRAFT", "STATEMENT_UPLOADED", "OCR_DONE"].includes(status)) {
      return c.json({ error: `Cannot add statements while ${status}` }, 409);
    }

    const statement = await prisma.statementUpload.create({
      data: { applicationId, fileRef, ocrStatus: "PENDING" },
    });

    if (status === "DRAFT") {
      await transitionApplication({
        applicationId,
        to: "STATEMENT_UPLOADED",
        reason: `Statement added (${fileRef})`,
        correlationId: application.correlationId,
      });
    }

    await queue(QUEUE.ocr).add(
      "extract",
      { applicationId, statementId: statement.id, fileRef, correlationId: application.correlationId },
      { ...DURABLE_JOB_OPTS, jobId: toJobId(`ocr:${statement.id}`) },
    );

    return c.json({ status: "queued", statementId: statement.id }, 201);
  },
);

/** Remove a statement from the cart. */
quizRoutes.delete("/:id/statements/:statementId", requireDraft, async (c) => {
  const applicationId = c.get("applicationId");
  const application = await prisma.loanApplication.findUniqueOrThrow({
    where: { id: applicationId },
    select: { status: true },
  });
  const status = application.status as ApplicationStatus;
  if (!["DRAFT", "STATEMENT_UPLOADED", "OCR_DONE"].includes(status)) {
    return c.json({ error: `Cannot change statements while ${status}` }, 409);
  }
  await prisma.statementUpload.deleteMany({
    where: { id: c.req.param("statementId"), applicationId },
  });
  return c.json({ ok: true });
});

/** Save the KALP answers. Atomic — a half-written assessment is worse than none. */
quizRoutes.patch("/:id/kalp", requireDraft, zValidator("json", kalpAnswersSchema), async (c) => {
  const applicationId = c.get("applicationId");
  const application = await prisma.loanApplication.findUniqueOrThrow({
    where: { id: applicationId },
    select: { status: true },
  });
  if (application.status !== "OCR_DONE") {
    return c.json({ error: `Cannot answer while ${application.status}` }, 409);
  }
  await prisma.loanApplication.update({ where: { id: applicationId }, data: c.req.valid("json") });
  return c.json({ ok: true });
});

/** Save contact details. On an anonymous draft this is application-only — no customer exists yet. */
quizRoutes.patch("/:id/contact", requireDraft, zValidator("json", contactSchema), async (c) => {
  const applicationId = c.get("applicationId");
  const { email, phone } = c.req.valid("json");
  await prisma.loanApplication.update({
    where: { id: applicationId },
    data: { contactEmail: email, contactPhone: phone ?? null },
  });
  return c.json({ ok: true });
});

/**
 * Finish the quiz → capture the lead.
 *
 * Requires the whole lead to be complete (statements read, KALP answered,
 * contact given). Mints a one-time `claimToken` — the stand-in for the magic
 * link that would be emailed — which the authenticated app presents to attach
 * this lead to a verified customer.
 */
quizRoutes.post("/:id/lead", requireDraft, async (c) => {
  const applicationId = c.get("applicationId");
  const application = await prisma.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });

  if (application.status !== "OCR_DONE") {
    return c.json({ error: `Cannot capture a lead while ${application.status}` }, 409);
  }
  if (!kalpComplete(application)) {
    return c.json({ error: "Affordability questions must be answered first" }, 409);
  }
  if (!application.contactEmail) {
    return c.json({ error: "Contact details are required" }, 409);
  }

  const claimToken = token();
  await prisma.$transaction(async (tx) => {
    await tx.loanApplication.update({ where: { id: applicationId }, data: { claimToken } });
    await transitionApplication(
      { applicationId, to: "LEAD", reason: "Quiz complete — lead captured", correlationId: application.correlationId },
      tx,
    );
  });

  // In production this token is emailed as a magic link, never returned in the
  // body. Returned here so the demo can carry it into the app phase.
  return c.json({ status: "LEAD", claimToken });
});

// ===========================================================================
// Phase 2 — authenticated app
// ===========================================================================

export const appRoutes = new Hono<AuthEnv>();

// requireAuth is applied per-route, NOT as a blanket `use("*")`. Both this
// router and quizRoutes mount on /applications, and a wildcard middleware here
// would run for the anonymous quiz routes too — blocking the very create call
// that must be public.

/**
 * Claim a lead.
 *
 * BankID has produced a session; this binds the anonymous lead to the verified
 * customer. The claimToken is one-time — cleared here — so a leaked link can't
 * be replayed to hijack the lead after it's been claimed.
 */
appRoutes.post("/claim", requireAuth, zValidator("json", claimSchema), async (c) => {
  const customerId = c.get("customerId");
  const { claimToken } = c.req.valid("json");

  const lead = await prisma.loanApplication.findUnique({ where: { claimToken } });
  if (!lead || lead.status !== "LEAD" || lead.customerId) {
    return c.json({ error: "No claimable lead for that token" }, 404);
  }

  const claimed = await prisma.$transaction(async (tx) => {
    // Copy the lead's contact onto the now-known customer.
    if (lead.contactEmail) {
      await tx.customer.update({
        where: { id: customerId },
        data: { email: lead.contactEmail, phone: lead.contactPhone ?? undefined },
      });
    }
    return tx.loanApplication.update({
      where: { id: lead.id },
      // Retire both tokens: the quiz is over and the lead is now owned.
      data: { customerId, claimToken: null, draftToken: null },
    });
  });

  await prisma.applicationEvent.create({
    data: {
      applicationId: claimed.id,
      fromStatus: "LEAD",
      toStatus: "LEAD",
      reason: "Lead claimed by verified customer",
      correlationId: claimed.correlationId,
    },
  });

  return c.json({ id: claimed.id });
});

/** List the caller's owned applications. */
appRoutes.get("/", requireAuth, async (c) => {
  const applications = await prisma.loanApplication.findMany({
    where: { customerId: c.get("customerId") },
    orderBy: { createdAt: "desc" },
    include: { offer: true, statements: true },
  });
  return c.json(applications);
});

/** Full owned-application state — polled by the app while jobs run. */
appRoutes.get("/:id", requireAuth, async (c) => {
  const application = await prisma.loanApplication.findFirst({
    where: { id: c.req.param("id"), customerId: c.get("customerId") },
    include: {
      statements: { orderBy: { createdAt: "asc" } },
      creditDecision: true,
      kycCheck: true,
      events: { orderBy: { createdAt: "asc" } },
      offer: { include: { loan: { include: { schedule: { orderBy: { installmentNo: "asc" } } } } } },
    },
  });
  if (!application) return c.json({ error: "Not found" }, 404);
  const { draftToken: _d, claimToken: _c, ...safe } = application;
  return c.json(safe);
});

/**
 * Submit a claimed lead for assessment.
 *
 * Fan-out then fan-in: credit-check + kyc-aml run concurrently as children and
 * `decision` runs only once BOTH succeed. This is the first and only point the
 * credit bureau is touched — deliberately, after identity is verified.
 */
appRoutes.post("/:id/submit", requireAuth, async (c) => {
  const applicationId = c.req.param("id");
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, customerId: c.get("customerId") },
    include: { customer: true },
  });
  if (!application || !application.customer) return c.json({ error: "Not found" }, 404);

  const status = application.status as ApplicationStatus;
  if (status !== "LEAD") {
    return c.json({ error: `Cannot submit from ${status}`, status }, 409);
  }
  // Guard: never start an assessment we can't legally complete. Cheaper to fail
  // here than to burn a hard UC inquiry in the worker.
  if (!kalpComplete(application)) {
    return c.json({ error: "Affordability questions must be answered first" }, 409);
  }

  await transitionApplication({
    applicationId,
    to: "UNDER_REVIEW",
    reason: "Submitted for credit + KYC assessment",
    correlationId: application.correlationId,
    expectedFrom: "LEAD",
  });

  const personalNumber = decryptPii(application.customer.personalNumberEnc);
  const base = { applicationId, correlationId: application.correlationId };

  await flowProducer.add({
    name: "decide",
    queueName: QUEUE.decision,
    data: base,
    opts: { ...DURABLE_JOB_OPTS, jobId: toJobId(`decision:${applicationId}`) },
    children: [
      {
        name: "credit-check",
        queueName: QUEUE.creditCheck,
        data: { ...base, personalNumber },
        opts: { ...DURABLE_JOB_OPTS, jobId: toJobId(`credit:${applicationId}`) },
      },
      {
        name: "kyc-aml",
        queueName: QUEUE.kycAml,
        data: { ...base, personalNumber },
        opts: { ...DURABLE_JOB_OPTS, jobId: toJobId(`kyc:${applicationId}`) },
      },
    ],
  });

  await queue(QUEUE.notifications).add(
    "application-submitted",
    {
      channel: "email",
      template: "application-received",
      to: application.contactEmail ?? "customer@example.com",
      correlationId: application.correlationId,
      data: { applicationId },
    },
    BEST_EFFORT_JOB_OPTS,
  );

  return c.json({ status: "UNDER_REVIEW" });
});
