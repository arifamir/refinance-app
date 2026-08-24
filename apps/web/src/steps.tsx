/**
 * Presentational steps.
 *
 * One decision per screen, in the same order as the real apply flow:
 * lender → upload → cart → KALP intro → accommodation → spouse → children →
 * income → income source → existing debt → contact.
 *
 * Every question screen is the same shape — a heading and a list of tappable
 * rows — so `ChoiceStep` covers most of them.
 */

import { useState, type ReactNode } from "react";
import { formatBps, formatMinor, type Application, type Statement } from "./api";
import { CATEGORIES, LENDERS, initials, type CategoryKey } from "./lenders";
import type { Quality } from "./store";

/** Bottom-docked primary action, as in their flow. */
export function Dock({ children }: { children: ReactNode }) {
  return (
    <div className="dock">
      <div className="dock-inner">{children}</div>
    </div>
  );
}

// --- generic question screens ---------------------------------------------

interface Choice<T> {
  label: string;
  value: T;
}

export function ChoiceStep<T>({
  title,
  lead,
  options,
  onPick,
}: {
  title: string;
  lead?: string;
  options: Choice<T>[];
  onPick: (value: T) => void;
}) {
  return (
    <>
      <h2>{title}</h2>
      {lead && <p className="lead">{lead}</p>}
      <div className="list">
        {options.map((option, i) => (
          <button key={i} className="row" onClick={() => onPick(option.value)}>
            <span className="row-name">{option.label}</span>
            <span className="chev">›</span>
          </button>
        ))}
      </div>
    </>
  );
}

// --- lender picker ---------------------------------------------------------

export function LenderPicker({
  onPick,
  disabled,
}: {
  onPick: (name: string) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryKey>("popular");

  const shown = LENDERS.filter((l) =>
    query.trim()
      ? l.name.toLowerCase().includes(query.trim().toLowerCase())
      : l.categories.includes(category),
  );

  return (
    <>
      <h2>Pick your current lender</h2>

      <div className="search">
        <span aria-hidden="true">🔍</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search lender"
          aria-label="Search lender"
        />
      </div>

      {!query.trim() && (
        <div className="chips">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`chip${category === c.key ? " on" : ""}`}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <h3 className="muted">
        {query.trim()
          ? `${shown.length} result${shown.length === 1 ? "" : "s"}`
          : "Most popular lenders"}
      </h3>

      <div className="list">
        {shown.map((l) => (
          <button
            key={l.name}
            className="row"
            disabled={disabled}
            onClick={() => onPick(l.name)}
          >
            <span className="avatar" style={{ background: l.colour }}>
              {initials(l.name)}
            </span>
            <span className="row-name">{l.name}</span>
            <span className="chev">›</span>
          </button>
        ))}
        {shown.length === 0 && <p className="muted">No lenders match “{query}”.</p>}
      </div>
    </>
  );
}

// --- upload ----------------------------------------------------------------

export function UploadStep({
  lender,
  quality,
  setQuality,
  onUpload,
  busy,
}: {
  lender: string;
  quality: Quality;
  setQuality: (q: Quality) => void;
  onUpload: () => void;
  busy: boolean;
}) {
  const colour = LENDERS.find((l) => l.name === lender)?.colour ?? "#5da9dd";

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 22 }}>
        <span
          className="avatar"
          style={{ background: colour, width: 54, height: 54, fontSize: 17 }}
        >
          {initials(lender)}
        </span>
        <h2 style={{ margin: 0 }}>{lender}</h2>
      </div>

      <p className="lead">Upload a photo, screenshot or pdf of your latest statement.</p>

      <h3>Images must include:</h3>
      <div style={{ marginBottom: 28 }}>
        <div className="inforow">
          <span className="ico">🔗</span> Current loan balance
        </div>
        <div className="inforow">
          <span className="ico">%</span> Interest rate
        </div>
        <div className="inforow">
          <span className="ico">🏦</span> Lender
        </div>
      </div>

      <h3 className="muted">Simulate statement quality</h3>
      <div className="seg">
        <button className={quality === "clean" ? "on" : ""} onClick={() => setQuality("clean")}>
          Readable
        </button>
        <button
          className={quality === "lowconf" ? "on" : ""}
          onClick={() => setQuality("lowconf")}
        >
          Unreadable
        </button>
        <button className={quality === "fail" ? "on" : ""} onClick={() => setQuality("fail")}>
          OCR error
        </button>
      </div>
      <p className="muted" style={{ fontSize: 14 }}>
        {quality === "clean" && "Extracts cleanly and moves on."}
        {quality === "lowconf" && "Confidence too low — this statement is dropped."}
        {quality === "fail" && "Throws in the worker — watch BullMQ retry with backoff."}
      </p>

      <Dock>
        <button className="btn btn-primary btn-block" onClick={onUpload} disabled={busy}>
          {busy ? "Uploading…" : "Add image"} <span className="arrow">→</span>
        </button>
      </Dock>
    </>
  );
}

// --- cart ------------------------------------------------------------------

export function CartStep({
  statements,
  onAddMore,
  onRemove,
  onContinue,
  busy,
}: {
  statements: Statement[];
  onAddMore: () => void;
  onRemove: (id: string) => void;
  onContinue: () => void;
  busy: boolean;
}) {
  const pending = statements.filter((s) => s.ocrStatus === "PENDING").length;
  const readable = statements.filter((s) => s.ocrStatus === "DONE");

  const total = readable.reduce((sum, s) => sum + (s.extractedBalanceMinor ?? 0), 0);

  return (
    <>
      <h2>Statements to submit</h2>
      <p className="lead">
        You can always add multiple invoices from different lenders. We will compile
        everything in one monthly invoice for you.
      </p>

      <h3>Images</h3>
      <div className="list" style={{ marginBottom: 20 }}>
        {statements.map((s) => (
          <div className="row" key={s.id} style={{ cursor: "default" }}>
            <span className="ico" style={{ fontSize: 20 }}>
              🧾
            </span>
            <span className="row-name">
              {s.extractedLender ?? s.fileRef.split("__")[0]?.replace(/-/g, " ")}
              <br />
              <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
                {s.ocrStatus === "PENDING" && "Reading…"}
                {s.ocrStatus === "FAILED" && "Couldn't read this one"}
                {s.ocrStatus === "DONE" &&
                  `${formatMinor(s.extractedBalanceMinor ?? 0)} @ ${formatBps(
                    s.extractedAprBps ?? 0,
                  )}`}
              </span>
            </span>
            <button
              className="iconbtn"
              onClick={() => onRemove(s.id)}
              aria-label="Remove statement"
            >
              🗑
            </button>
          </div>
        ))}
      </div>

      <button
        className="btn btn-ghost"
        onClick={onAddMore}
        style={{ marginBottom: 24 }}
      >
        Add more loans <span className="arrow">→</span>
      </button>

      {readable.length > 1 && (
        <div className="card">
          <div className="kv">
            <div>
              <span className="k">Total to refinance</span>
              <span className="v">{formatMinor(total)}</span>
            </div>
            <div>
              <span className="k">Across</span>
              <span className="v">{readable.length} lenders</span>
            </div>
          </div>
        </div>
      )}

      <div className="card flat">
        <div style={{ display: "flex", gap: 13 }}>
          <span aria-hidden="true">?</span>
          <span style={{ fontSize: 15 }}>
            Is there more information on the back of your invoice? You can always send in
            multiple images. Try to capture all four corners of the invoice.
          </span>
        </div>
      </div>

      <Dock>
        <button
          className="btn btn-primary btn-block"
          onClick={onContinue}
          disabled={busy || pending > 0 || readable.length === 0}
        >
          {pending > 0 ? `Reading ${pending} statement${pending > 1 ? "s" : ""}…` : "Continue"}{" "}
          <span className="arrow">→</span>
        </button>
      </Dock>
    </>
  );
}

// --- KALP intro ------------------------------------------------------------

export function KalpIntro({ onNext }: { onNext: () => void }) {
  return (
    <div className="center">
      <div style={{ fontSize: 74, lineHeight: 1, margin: "20px 0 30px" }}>🧑‍💻</div>
      <h2>A few questions about your finances</h2>
      <p className="lead">
        As a responsible financial institution we are required to understand your financial
        situation before we can proceed with your application. But don't worry — this will be
        quick!
      </p>
      <p className="muted" style={{ fontSize: 14 }}>
        This is the KALP assessment — <em>Kvar Att Leva På</em>, “what's left to live on”.
        Swedish law requires it before any consumer credit.
      </p>

      <Dock>
        <button className="btn btn-primary btn-block" onClick={onNext}>
          Let's do this <span className="arrow">→</span>
        </button>
      </Dock>
    </div>
  );
}

// --- income ----------------------------------------------------------------

export function IncomeStep({
  value,
  onChange,
  onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
}) {
  const digits = value.replace(/\D/g, "");
  const valid = digits.length > 0 && Number(digits) > 0;

  return (
    <>
      <h2>What is your monthly income?</h2>
      <h3 className="muted">Income before tax</h3>

      <div className="search" style={{ justifyContent: "space-between" }}>
        <input
          value={value}
          inputMode="numeric"
          autoFocus
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, "");
            onChange(raw ? Number(raw).toLocaleString("sv-SE") : "");
          }}
          placeholder="0"
          aria-label="Monthly income before tax"
        />
        <span className="muted">kr</span>
      </div>

      <Dock>
        <button className="btn btn-primary btn-block" onClick={onNext} disabled={!valid}>
          Next <span className="arrow">→</span>
        </button>
      </Dock>
    </>
  );
}

// --- contact ---------------------------------------------------------------

export function ContactStep({
  email,
  phone,
  setEmail,
  setPhone,
  onSubmit,
  busy,
}: {
  email: string;
  phone: string;
  setEmail: (v: string) => void;
  setPhone: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const [confirm, setConfirm] = useState("");
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const matches = email === confirm;

  return (
    <>
      <h2>Almost there…</h2>
      <p className="lead">We need a way to get in touch with you.</p>

      <h3 className="muted">Email</h3>
      <div className="search" style={{ marginBottom: 18 }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Email"
        />
      </div>

      <h3 className="muted">Confirm your email</h3>
      <div className="search" style={{ marginBottom: 18 }}>
        <input
          type="email"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="you@example.com"
          aria-label="Confirm your email"
        />
      </div>

      <h3 className="muted">Phone number (optional)</h3>
      <div className="search" style={{ marginBottom: 24 }}>
        <span aria-hidden="true">🇸🇪</span>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+46"
          aria-label="Phone number"
        />
      </div>

      {email && confirm && !matches && (
        <div className="error">The email addresses don't match.</div>
      )}

      {/* Statutory consumer-credit warning. Not decoration — Swedish lenders
          are required to display it. */}
      <div className="card flat">
        <div style={{ display: "flex", gap: 14 }}>
          <span style={{ fontSize: 26, lineHeight: 1 }} aria-hidden="true">
            ⚠️
          </span>
          <div style={{ fontSize: 14.5 }}>
            <b>Borrowing costs money!</b>
            <br />
            If you are unable to repay your debt on time, you risk receiving a payment
            remark. This can lead to difficulties in renting a home, signing contracts, and
            obtaining new loans. For support, contact the budget and debt counselling
            service in your municipality. Contact details are available at konsumentverket.se.
          </div>
        </div>
      </div>

      <Dock>
        <button
          className="btn btn-primary btn-block"
          onClick={onSubmit}
          disabled={busy || !emailOk || !matches}
        >
          {busy ? "Submitting…" : "Submit application"} <span className="arrow">→</span>
        </button>
      </Dock>
    </>
  );
}

// --- lead captured (handoff to the authenticated app) ----------------------

export function LeadCaptured({
  email,
  onContinue,
  busy,
}: {
  email: string;
  onContinue: () => void;
  busy: boolean;
}) {
  return (
    <div className="center">
      <div style={{ fontSize: 60, lineHeight: 1, margin: "18px 0 26px" }}>✅</div>
      <h2>Thanks — we've got your details</h2>
      <p className="lead">
        We've saved your application{email ? <> and sent a link to <b>{email}</b></> : ""}. To see
        your offer, verify your identity with BankID in the app.
      </p>

      <div className="card flat" style={{ textAlign: "left" }}>
        <p style={{ margin: 0, fontSize: 14 }}>
          Everything up to here was anonymous — no BankID on the website. Identity happens only
          now, in the app, where it's actually needed: to run the credit check and sign the
          agreement.
        </p>
      </div>

      <Dock>
        <button className="btn btn-primary btn-block" onClick={onContinue} disabled={busy}>
          {busy ? "Opening BankID…" : "Open the app & verify with BankID"}{" "}
          <span className="arrow">→</span>
        </button>
      </Dock>
    </div>
  );
}

// --- assessment / outcome --------------------------------------------------

export function Assessing({ application }: { application: Application }) {
  const credit = Boolean(application.creditDecision);
  const kyc = Boolean(application.kycCheck);

  return (
    <div className="center">
      <div className="spinner" />
      <h2>Checking your loan</h2>
      <p className="lead">
        This runs in background workers, so you can close the app — we'll finish either way.
      </p>

      <div className="steps">
        <Step done live={false} label="Statements read" />
        <Step done={credit} live={!credit} label="Credit assessment & KALP" />
        <Step done={kyc} live={!kyc} label="Identity & AML checks" />
        <Step done={false} live={credit && kyc} label="Preparing your offer" />
      </div>

      {application.existingLender && (
        <div className="card flat" style={{ marginTop: 28, textAlign: "left" }}>
          <div className="kv">
            <div>
              <span className="k">Refinancing</span>
              <span className="v">{application.existingLender}</span>
            </div>
            <div>
              <span className="k">Balance</span>
              <span className="v">{formatMinor(application.existingBalanceMinor ?? 0)}</span>
            </div>
            <div>
              <span className="k">Weighted rate</span>
              <span className="v">{formatBps(application.existingAprBps ?? 0)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Step({ done, live, label }: { done: boolean; live: boolean; label: string }) {
  return (
    <div className={done ? "done" : live ? "live" : ""}>
      <span className="tick">{done ? "✓" : live ? "•" : ""}</span>
      {label}
    </div>
  );
}

export function Waiting({ title, lead }: { title: string; lead: string }) {
  return (
    <div className="center">
      <div className="spinner" />
      <h2>{title}</h2>
      <p className="lead">{lead}</p>
    </div>
  );
}

export function Rejected({
  reason,
  kalpMinor,
  onRestart,
}: {
  reason: string;
  kalpMinor: number | null;
  onRestart: () => void;
}) {
  return (
    <div className="center">
      <h2>We can't offer you a loan</h2>
      <p className="lead">{reason}</p>

      {kalpMinor !== null && kalpMinor < 0 && (
        <div className="card flat" style={{ textAlign: "left" }}>
          <p style={{ margin: 0, fontSize: 14.5 }}>
            After standardised living costs and a stress-tested interest rate, this loan
            would leave you <b>{formatMinor(kalpMinor)}</b> short each month. Declining is
            the outcome the affordability rules exist to produce.
          </p>
        </div>
      )}

      <button className="btn btn-ghost" onClick={onRestart}>
        Start over
      </button>
    </div>
  );
}
