/**
 * Two-phase flow: an anonymous web quiz and a separate authenticated app.
 *
 *   PHASE 1 — anonymous web quiz. No BankID anywhere. A draft is authorised by
 *   a capability token; the customer picks lenders, uploads statements, answers
 *   the KALP questions and leaves contact details. It ends at a "lead captured"
 *   screen. Nothing is assessed — no identity has been established.
 *
 *   PHASE 2 — the authenticated app. BankID verifies identity, CLAIMS the lead
 *   (via the handoff token that would be a magic link in production), and only
 *   then submits for the credit check. From there the server drives.
 *
 * Identity is required only when we ACT on the data, never to collect it — that
 * is the whole point of the split, and it's how a real funnel maximises
 * conversion: the highest-friction step comes last, once the customer is
 * invested.
 */

import { useCallback, useEffect, useState } from "react";
import {
  api,
  createDraft,
  draftApi,
  formatBps,
  formatMinor,
  getToken,
  setToken,
  type Application,
  type BankIdCollect,
  type BankIdStart,
} from "./api";
import { DEBT_BUCKETS, slug } from "./lenders";
import {
  Assessing,
  CartStep,
  ChoiceStep,
  ContactStep,
  Dock,
  IncomeStep,
  KalpIntro,
  LeadCaptured,
  LenderPicker,
  Rejected,
  UploadStep,
  Waiting,
} from "./steps";
import { STAGE_PROGRESS, isKalpComplete, useWizard } from "./store";
import { UcChecker } from "./UcChecker";

const POLL_MS = 1000;

export function App() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [customer, setCustomer] = useState<{ displayName: string | null } | null>(null);
  const [application, setApplication] = useState<Application | null>(null);
  const [signTerms, setSignTerms] = useState<string | null>(null);
  const [incomeText, setIncomeText] = useState("");
  const [devOpen, setDevOpen] = useState(false);
  // Two independent tools share the page: the loan flow and the score checker.
  const [view, setView] = useState<"main" | "ucScore">("main");

  const w = useWizard();
  const draft = w.draftToken ? draftApi(w.draftToken) : null;

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const pollBankId = useCallback(
    async (path: string, orderRef: string): Promise<BankIdCollect> => {
      for (let i = 0; i < 60; i++) {
        const result = await api.post<BankIdCollect>(path, { orderRef });
        if (result.status !== "pending") return result;
        await new Promise((r) => setTimeout(r, 600));
      }
      throw new Error("BankID order timed out");
    },
    [],
  );

  // --- Phase 1: anonymous quiz --------------------------------------------

  const startQuiz = () =>
    run("start", async () => {
      const { id, draftToken } = await createDraft(48);
      w.setDraft(id, draftToken);
      w.goTo("lender");
    });

  const chooseLender = (name: string) => {
    w.setLender(name);
    w.goTo("upload");
  };

  const upload = () =>
    run("upload", async () => {
      if (!draft || !w.applicationId || !w.lender) return;
      const suffix = w.quality === "clean" ? "statement-2026.jpg" : `statement-${w.quality}.jpg`;
      await draft.post(`/applications/${w.applicationId}/statements`, {
        fileRef: `${slug(w.lender)}__${suffix}`,
      });
      w.goTo("cart");
    });

  const removeStatement = (statementId: string) =>
    run("remove", async () => {
      if (!draft || !w.applicationId) return;
      await draft.del(`/applications/${w.applicationId}/statements/${statementId}`);
      setApplication(await draft.get<Application>(`/applications/${w.applicationId}/draft`));
    });

  /** Finish the quiz: save answers atomically, capture the lead, mint the handoff token. */
  const captureLead = () =>
    run("lead", async () => {
      const id = w.applicationId;
      if (!draft || !id || !isKalpComplete(w.answers)) return;
      await draft.patch(`/applications/${id}/kalp`, w.answers);
      await draft.patch(`/applications/${id}/contact`, {
        email: w.email,
        phone: w.phone || undefined,
      });
      const { claimToken } = await draft.post<{ claimToken: string }>(`/applications/${id}/lead`);
      w.setClaimToken(claimToken);
      w.goTo("leadCaptured");
    });

  // --- Phase 2: authenticated app -----------------------------------------

  /** BankID verify -> claim the lead -> submit for assessment. */
  const continueToApp = () =>
    run("continue", async () => {
      // 1. BankID identity.
      const start = await api.post<BankIdStart>("/auth/bankid/start", {});
      const authResult = await pollBankId("/auth/bankid/collect", start.orderRef);
      if (authResult.status !== "complete" || !("token" in authResult)) {
        throw new Error("Authentication failed");
      }
      setToken(authResult.token);
      setCustomer(authResult.customer);

      // 2. Claim the anonymous lead — binds it to this verified customer.
      if (!w.claimToken) throw new Error("No lead to claim");
      const { id } = await api.post<{ id: string }>("/applications/claim", {
        claimToken: w.claimToken,
      });
      w.setApplicationId(id);

      // 3. Submit — the first and only point the credit bureau is touched.
      await api.post(`/applications/${id}/submit`);
      w.goTo("app");
    });

  const sign = () =>
    run("sign", async () => {
      const offer = application?.offer;
      if (!offer) return;
      const start = await api.post<BankIdStart>(`/offers/${offer.id}/sign/start`, {});
      setSignTerms(start.termsShownToUser ?? null);
      const result = await pollBankId(`/offers/${offer.id}/sign/collect`, start.orderRef);
      if (result.status !== "complete") throw new Error("Signing failed");
      setSignTerms(null);
    });

  const restart = () => {
    setToken(null);
    w.reset();
    setApplication(null);
    setCustomer(null);
    setSignTerms(null);
    setIncomeText("");
    setError(null);
  };

  // --- polling -------------------------------------------------------------
  // Quiz: poll the draft view (statements being read). App: poll the owned view.

  const appId = w.applicationId;
  const stage = w.stage;
  const inApp = stage === "app" && Boolean(getToken());
  const draftToken = w.draftToken;

  useEffect(() => {
    if (!appId) return;
    if (!inApp && !draftToken) return;
    let cancelled = false;
    let handle: number;

    const fetchState = async () => {
      if (inApp) return api.get<Application>(`/applications/${appId}`);
      const d = draftApi(draftToken!);
      return d.get<Application>(`/applications/${appId}/draft`);
    };

    const tick = async () => {
      try {
        const next = await fetchState();
        if (!cancelled) setApplication(next);
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled) handle = window.setTimeout(tick, POLL_MS);
    };

    handle = window.setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [appId, inApp, draftToken]);

  // --- routing -------------------------------------------------------------

  const status = application?.status;
  const offer = application?.offer ?? null;
  const loan = offer?.loan ?? null;

  // The standalone score checker — a separate tool from the loan flow.
  if (view === "ucScore") {
    return <UcChecker onBack={() => setView("main")} />;
  }

  // Landing: no draft started yet.
  if (!w.draftToken && stage === "lender") {
    return (
      <>
        <Hero
          onApply={startQuiz}
          onCheckScore={() => setView("ucScore")}
          busy={busy === "start"}
        />
        <DevDrawer open={devOpen} setOpen={setDevOpen} application={null} />
      </>
    );
  }

  // In the app phase the SERVER decides the screen.
  const appScreen =
    stage !== "app"
      ? null
      : status === "REJECTED"
        ? "rejected"
        : status === "OFFERED" || status === "SIGN_FAILED"
          ? "offer"
          : status === "SIGNING"
            ? "signing"
            : loan?.status === "ACTIVE"
              ? "active"
              : status === "ACCEPTED"
                ? "disbursing"
                : "assessing";

  const screen = appScreen ?? stage;
  const progress = appScreen
    ? { assessing: 0.94, offer: 0.96, signing: 0.98, disbursing: 0.99, active: 1, rejected: 1 }[
        appScreen
      ]!
    : STAGE_PROGRESS[stage];

  const canGoBack = w.history.length > 0 && !appScreen && stage !== "leadCaptured";

  return (
    <div className="app">
      <header className="topbar">
        {canGoBack ? (
          <button className="iconbtn" onClick={w.back} aria-label="Back">
            ←
          </button>
        ) : (
          <Brand />
        )}
        {customer?.displayName && <span className="pill">{customer.displayName}</span>}
      </header>

      {/* The progress rail belongs to the quiz funnel only. Once inside the
          authenticated app the server drives the screens, so a linear bar would
          be misleading. */}
      {!appScreen && (
        <div className="progress">
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      <main className={`screen${screen === "active" ? " wide" : ""}`} key={screen}>
        {error && <div className="error">{error}</div>}

        {screen === "lender" && <LenderPicker onPick={chooseLender} disabled={busy !== null} />}

        {screen === "upload" && w.lender && (
          <UploadStep
            lender={w.lender}
            quality={w.quality}
            setQuality={w.setQuality}
            onUpload={upload}
            busy={busy === "upload"}
          />
        )}

        {screen === "cart" && (
          <CartStep
            statements={application?.statements ?? []}
            onAddMore={() => w.goTo("lender")}
            onRemove={removeStatement}
            onContinue={() => w.goTo("kalpIntro")}
            busy={busy !== null}
          />
        )}

        {screen === "kalpIntro" && <KalpIntro onNext={() => w.goTo("accommodation")} />}

        {screen === "accommodation" && (
          <ChoiceStep
            title="Do you own your accommodation?"
            options={[
              { label: "Yes", value: true },
              { label: "No", value: false },
            ]}
            onPick={(v) => {
              w.answer("ownsAccommodation", v);
              w.goTo("spouse");
            }}
          />
        )}

        {screen === "spouse" && (
          <ChoiceStep
            title="Do you live together with another adult?"
            options={[
              { label: "Yes", value: true },
              { label: "No", value: false },
            ]}
            onPick={(v) => {
              w.answer("hasSpouse", v);
              w.goTo("kids");
            }}
          />
        )}

        {screen === "kids" && (
          <ChoiceStep
            title="How many children under the age of 18 do you have?"
            options={[0, 1, 2, 3, 4, 5].map((n) => ({
              label: n === 5 ? "5 or more" : String(n),
              value: n,
            }))}
            onPick={(v) => {
              w.answer("numberOfChildren", v);
              w.goTo("income");
            }}
          />
        )}

        {screen === "income" && (
          <IncomeStep
            value={incomeText}
            onChange={setIncomeText}
            onNext={() => {
              const kr = Number(incomeText.replace(/\D/g, ""));
              w.answer("monthlyIncomeGrossMinor", kr * 100);
              w.goTo("source");
            }}
          />
        )}

        {screen === "source" && (
          <ChoiceStep
            title="What best describes your source of income?"
            options={[
              { label: "Permanent Employment", value: "PERMANENT_EMPLOYMENT" },
              { label: "Fixed-term Employment", value: "FIXED_TERM_EMPLOYMENT" },
              { label: "Self-employed", value: "SELF_EMPLOYED" },
              { label: "Other", value: "OTHER" },
            ]}
            onPick={(v) => {
              w.answer("incomeSource", v);
              w.goTo("debt");
            }}
          />
        )}

        {screen === "debt" && (
          <ChoiceStep
            title="How much do you pay each month for your loans?"
            lead="Include interest, fees and amortization. Also include loans where you are a guarantor."
            options={DEBT_BUCKETS.map((b) => ({ label: b.label, value: b.maxMinor }))}
            onPick={(v) => {
              w.answer("monthlyDebtPaymentMinor", v);
              w.goTo("contact");
            }}
          />
        )}

        {screen === "contact" && (
          <ContactStep
            email={w.email}
            phone={w.phone}
            setEmail={(v) => w.setContact(v, w.phone)}
            setPhone={(v) => w.setContact(w.email, v)}
            onSubmit={captureLead}
            busy={busy === "lead"}
          />
        )}

        {screen === "leadCaptured" && (
          <LeadCaptured email={w.email} onContinue={continueToApp} busy={busy === "continue"} />
        )}

        {screen === "assessing" && application && <Assessing application={application} />}

        {screen === "offer" && offer && application && (
          <OfferStep
            offer={offer}
            existingAprBps={application.existingAprBps ?? 0}
            lender={application.existingLender ?? ""}
            kalpMinor={application.creditDecision?.kalpMinor ?? null}
            onSign={sign}
            busy={busy === "sign"}
            retry={status === "SIGN_FAILED"}
          />
        )}

        {screen === "signing" && <SigningStep terms={signTerms} />}

        {screen === "disbursing" && application && (
          <Waiting
            title="Setting up your loan"
            lead={`We're paying off ${application.existingLender ?? "your old lender"} now. This is the one step that must never happen twice.`}
          />
        )}

        {screen === "active" && loan && offer && (
          <LoanStep loan={loan} offer={offer} onRestart={restart} />
        )}

        {screen === "rejected" && application && (
          <Rejected
            reason={application.creditDecision?.reason ?? "We couldn't read your statements."}
            kalpMinor={application.creditDecision?.kalpMinor ?? null}
            onRestart={restart}
          />
        )}
      </main>

      <DevDrawer open={devOpen} setOpen={setDevOpen} application={application} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      Refinance
    </div>
  );
}

function Hero({
  onApply,
  onCheckScore,
  busy,
}: {
  onApply: () => void;
  onCheckScore: () => void;
  busy: boolean;
}) {
  // Illustrative declining-balance chart for the offer-preview card.
  const bars = [100, 94, 88, 81, 74, 66, 58, 49, 40, 30, 20, 10];

  return (
    <div className="hero">
      <header className="topbar on-hero">
        <Brand />
        <button className="btn btn-primary" onClick={onApply} disabled={busy}>
          Apply now <span className="arrow">→</span>
        </button>
      </header>

      <div className="hero-body">
        <div className="hero-copy">
          <span className="badge-row">◆ Reference implementation</span>
          <h1>The app for your loans</h1>
          <p className="lead">
            See if we can lower the rate on your loans and credit. Get better control and smart
            features to pay off faster.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={onApply} disabled={busy}>
              {busy ? "Starting…" : "Apply online"} <span className="arrow">→</span>
            </button>
            <button className="btn btn-light" onClick={onCheckScore} disabled={busy}>
              Check your credit score 📊
            </button>
          </div>
          <div className="hero-trust">
            <span>
              <span className="ti" aria-hidden="true">
                ⚡
              </span>
              Estimate in minutes
            </span>
            <span>
              <span className="ti" aria-hidden="true">
                📉
              </span>
              One lower monthly payment
            </span>
            <span>
              <span className="ti" aria-hidden="true">
                🔒
              </span>
              Bank-grade security
            </span>
          </div>
        </div>

        {/* A floating offer preview — shows what the product does and gives the
            hero a focal point. Purely decorative, so it's hidden from a11y. */}
        <div className="hero-visual" aria-hidden="true">
          <div className="hero-card">
            <div className="hero-card-top">
              <span className="hero-card-eyebrow">Estimated offer</span>
              <span className="pill good">▼ 3.15%</span>
            </div>
            <div className="hero-card-amount">
              1 759 kr <small>/ mo</small>
            </div>
            <div className="hero-rate">
              <span className="strike">18.05%</span>
              <span className="hero-rate-arrow">→</span>
              <span className="hero-rate-new">14.90%</span>
            </div>
            <div className="hero-bars">
              {bars.map((h, i) => (
                <i key={i} style={{ height: `${h}%`, animationDelay: `${i * 55}ms` }} />
              ))}
            </div>
            <div className="hero-card-foot">
              <span>Interest saved</span>
              <b className="saving">4 927 kr</b>
            </div>
          </div>

          <div className="hero-chip hero-chip-1">
            <span className="dot">✓</span> Free to check
          </div>
          <div className="hero-chip hero-chip-2">Old lender paid off ✓</div>
        </div>
      </div>
    </div>
  );
}

function OfferStep({
  offer,
  existingAprBps,
  lender,
  kalpMinor,
  onSign,
  busy,
  retry,
}: {
  offer: NonNullable<Application["offer"]>;
  existingAprBps: number;
  lender: string;
  kalpMinor: number | null;
  onSign: () => void;
  busy: boolean;
  retry: boolean;
}) {
  return (
    <>
      <p className="eyebrow">Your offer</p>
      <h2>We can lower your rate</h2>

      <div className="card">
        <div className="amount">
          {formatMinor(offer.monthlyPaymentMinor)} <small>/ month</small>
        </div>
        <div className="kv" style={{ marginTop: 20 }}>
          <div>
            <span className="k">Refinancing from</span>
            <span className="v">{lender}</span>
          </div>
          <div>
            <span className="k">Amount</span>
            <span className="v">{formatMinor(offer.principalMinor)}</span>
          </div>
          <div>
            <span className="k">Your new rate</span>
            <span className="v">
              <span className="strike">{formatBps(existingAprBps)}</span>{" "}
              {formatBps(offer.offeredAprBps)}
            </span>
          </div>
          <div>
            <span className="k">Term</span>
            <span className="v">{offer.termMonths} months</span>
          </div>
          <div>
            <span className="k">Total interest saved</span>
            <span className="v saving">{formatMinor(offer.savingMinor)}</span>
          </div>
          {kalpMinor !== null && (
            <div>
              <span className="k">Left to live on (KALP)</span>
              <span className="v">{formatMinor(kalpMinor)} / month</span>
            </div>
          )}
        </div>
      </div>

      {retry && (
        <div className="error">
          The signing was cancelled. Your offer is still valid — try again.
        </div>
      )}

      <p className="muted" style={{ fontSize: 14 }}>
        Signing with BankID creates a legally binding credit agreement. The exact terms above
        appear on your phone before you confirm.
      </p>

      <Dock>
        <button className="btn btn-primary btn-block" onClick={onSign} disabled={busy}>
          {busy ? "Open BankID…" : "Sign with BankID"} <span className="arrow">→</span>
        </button>
      </Dock>
    </>
  );
}

function SigningStep({ terms }: { terms: string | null }) {
  return (
    <div className="center">
      <div className="spinner" />
      <h2>Open BankID</h2>
      <p className="lead">Confirm these terms on your device to sign the agreement.</p>
      {terms && <div className="bankid-box">{terms}</div>}
      <p className="muted" style={{ fontSize: 14 }}>
        This step is never retried automatically — a retry means a new order and fresh consent.
      </p>
    </div>
  );
}

function LoanStep({
  loan,
  offer,
  onRestart,
}: {
  loan: NonNullable<NonNullable<Application["offer"]>["loan"]>;
  offer: NonNullable<Application["offer"]>;
  onRestart: () => void;
}) {
  const paid = loan.schedule.filter((s) => s.status === "PAID").length;
  const [collecting, setCollecting] = useState(false);

  const collect = async () => {
    setCollecting(true);
    try {
      await api.post(`/ops/loans/${loan.id}/advance?months=1`);
      await api.post("/ops/run-collection");
    } finally {
      setTimeout(() => setCollecting(false), 1500);
    }
  };

  return (
    <>
      <p className="eyebrow">
        <span className="pill good">✓ Loan active</span>
      </p>
      <h2>You're all set</h2>
      <p className="lead">We've paid off your old lender. Your first payment is due next month.</p>

      <div className="card">
        <div className="kv">
          <div>
            <span className="k">Monthly payment</span>
            <span className="v">{formatMinor(offer.monthlyPaymentMinor)}</span>
          </div>
          <div>
            <span className="k">Rate</span>
            <span className="v">{formatBps(offer.offeredAprBps)}</span>
          </div>
          <div>
            <span className="k">Paid</span>
            <span className="v">
              {paid} / {loan.schedule.length}
            </span>
          </div>
          <div>
            <span className="k">Interest saved</span>
            <span className="v saving">{formatMinor(offer.savingMinor)}</span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "6px 0 22px" }}>
        <button className="btn btn-ghost" onClick={collect} disabled={collecting}>
          {collecting ? "Collecting…" : "Advance a month & collect"}
        </button>
        <button className="btn btn-ghost" onClick={onRestart}>
          New application
        </button>
      </div>

      <h3>Repayment schedule</h3>
      <div className="tablewrap scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Due</th>
              <th>Principal</th>
              <th>Interest</th>
              <th>Total</th>
              <th>Balance</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loan.schedule.map((row) => (
              <tr key={row.installmentNo} className={row.status === "PAID" ? "paid" : ""}>
                <td>{row.installmentNo}</td>
                <td>{row.dueDate.slice(0, 10)}</td>
                <td>{formatMinor(row.principalPartMinor)}</td>
                <td>{formatMinor(row.interestPartMinor)}</td>
                <td>{formatMinor(row.totalMinor)}</td>
                <td>{formatMinor(row.balanceAfterMinor)}</td>
                <td>{row.status === "PAID" ? "✓ Paid" : row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

type QueueCounts = Record<string, Record<string, number>>;

/**
 * Engineering view. The polished flow hides the machinery — this puts it back:
 * live queue depths, the KALP assessment, and the append-only transition log.
 */
function DevDrawer({
  open,
  setOpen,
  application,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  application: Application | null;
}) {
  const [queues, setQueues] = useState<QueueCounts>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let handle: number;

    const tick = async () => {
      try {
        const next = await api.get<QueueCounts>("/ops/queues");
        if (!cancelled) setQueues(next);
      } catch {
        /* ignore */
      }
      if (!cancelled) handle = window.setTimeout(tick, 1500);
    };

    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open]);

  if (!open) {
    return (
      <button className="devtoggle" onClick={() => setOpen(true)}>
        ⚙ Engineering
      </button>
    );
  }

  const kalp = application?.creditDecision;
  const events = application?.events ?? [];

  return (
    <div className="drawer">
      <button className="drawer-close" onClick={() => setOpen(false)} aria-label="Close">
        ✕
      </button>
      <div className="drawer-in">
        <h3>Under the hood</h3>

        <div className="sec">BullMQ queues</div>
        <div className="qgrid">
          {Object.entries(queues).map(([name, counts]) => (
            <div className="qcell" key={name}>
              <b>{name}</b>
              <span className="n">
                {counts.active ? <em>{counts.active} active</em> : `${counts.completed ?? 0} done`}
                {counts.waiting ? ` · ${counts.waiting} waiting` : ""}
                {counts.failed ? ` · ${counts.failed} failed` : ""}
                {counts.delayed ? ` · ${counts.delayed} delayed` : ""}
              </span>
            </div>
          ))}
        </div>

        {kalp && (
          <>
            <div className="sec">KALP assessment</div>
            <div className="trace">
              UC score <b>{kalp.bureauScore}</b> ({kalp.riskBand}) · stress-tested at{" "}
              <b>{kalp.stressedAprBps ? kalp.stressedAprBps / 100 : "—"}%</b>
              <br />
              Left to live on: <b>{kalp.kalpMinor !== null ? formatMinor(kalp.kalpMinor) : "—"}</b>
            </div>
          </>
        )}

        {events.length > 0 && (
          <>
            <div className="sec">State transitions (audit trail)</div>
            <div className="trace">
              {events.map((e) => (
                <div key={e.id}>
                  <span className="t">{new Date(e.createdAt).toLocaleTimeString()}</span>{" "}
                  <b>{e.toStatus}</b>
                  {e.reason ? ` · ${e.reason}` : ""}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
