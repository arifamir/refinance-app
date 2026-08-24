/**
 * Standalone credit-score checker — a separate tool from the loan flow.
 *
 * Authenticate with BankID, then read your bureau score. The teaching point is
 * that this is a SOFT check: it leaves no footprint on your record, unlike a
 * loan application, which triggers a hard inquiry. The UI states that plainly.
 */

import { useCallback, useState } from "react";
import { api, formatMinor, setToken, type BankIdCollect, type BankIdStart, type UcScore } from "./api";

const BANDS: Record<string, { label: string; cls: string }> = {
  LOW: { label: "Low risk", cls: "good" },
  MEDIUM: { label: "Medium risk", cls: "warn" },
  HIGH: { label: "High risk", cls: "bad" },
  VERY_HIGH: { label: "Very high risk", cls: "bad" },
};

export function UcChecker({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState<UcScore | null>(null);
  const [name, setName] = useState<string | null>(null);

  const pollBankId = useCallback(async (orderRef: string): Promise<BankIdCollect> => {
    for (let i = 0; i < 60; i++) {
      const result = await api.post<BankIdCollect>("/auth/bankid/collect", { orderRef });
      if (result.status !== "pending") return result;
      await new Promise((r) => setTimeout(r, 600));
    }
    throw new Error("BankID order timed out");
  }, []);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const start = await api.post<BankIdStart>("/auth/bankid/start", {});
      const auth = await pollBankId(start.orderRef);
      if (auth.status !== "complete" || !("token" in auth)) throw new Error("Authentication failed");
      setToken(auth.token);
      setName(auth.customer.displayName);
      setScore(await api.get<UcScore>("/uc-score"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="iconbtn" onClick={onBack} aria-label="Back">
          ←
        </button>
        {name && <span className="pill">{name}</span>}
      </header>

      <main className="screen center">
        {error && <div className="error">{error}</div>}

        {!score ? (
          <>
            <div style={{ fontSize: 60, lineHeight: 1, margin: "12px 0 24px" }}>📊</div>
            <h2>Check your credit score</h2>
            <p className="lead">
              See your credit score in seconds. This is a soft check — it leaves no footprint on
              your record and won't affect your rating.
            </p>

            <div className="card flat" style={{ textAlign: "left" }}>
              <div className="inforow">
                <span className="ico">🔒</span> Verified with BankID
              </div>
              <div className="inforow">
                <span className="ico">👣</span> Soft check — no footprint
              </div>
              <div className="inforow">
                <span className="ico">💸</span> Free, as often as you like
              </div>
            </div>

            <div className="dock">
              <div className="dock-inner">
                <button className="btn btn-primary btn-block" onClick={check} disabled={busy}>
                  {busy ? "Waiting for BankID…" : "Check my score with BankID"}{" "}
                  <span className="arrow">→</span>
                </button>
              </div>
            </div>
          </>
        ) : (
          <ScoreCard score={score} onRecheck={() => setScore(null)} onBack={onBack} />
        )}
      </main>
    </div>
  );
}

function ScoreCard({
  score,
  onRecheck,
  onBack,
}: {
  score: UcScore;
  onRecheck: () => void;
  onBack: () => void;
}) {
  const band = BANDS[score.riskBand] ?? { label: score.riskBand, cls: "" };

  return (
    <>
      <p className="eyebrow">Your credit score</p>

      <div className="card">
        <div className="amount" style={{ fontSize: 64 }}>
          {score.score}
          <small> / 100</small>
        </div>
        <div style={{ margin: "14px 0 6px" }}>
          <span className={`pill ${band.cls}`}>{band.label}</span>
        </div>

        {/* Score meter */}
        <div
          style={{
            height: 10,
            borderRadius: 999,
            marginTop: 16,
            background:
              "linear-gradient(90deg, #d9534f 0%, #e0a800 45%, #2f9e4f 100%)",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: `calc(${Math.max(0, Math.min(100, score.score))}% - 8px)`,
              top: -4,
              width: 18,
              height: 18,
              borderRadius: 999,
              background: "var(--white)",
              border: "3px solid var(--ink)",
            }}
          />
        </div>

        <div className="kv" style={{ marginTop: 22 }}>
          <div>
            <span className="k">Monthly disposable income</span>
            <span className="v">{formatMinor(score.monthlyDisposableIncomeMinor)}</span>
          </div>
          <div>
            <span className="k">Existing debt</span>
            <span className="v">{formatMinor(score.existingDebtMinor)}</span>
          </div>
          <div>
            <span className="k">Payment remarks</span>
            <span className="v">{score.paymentRemarks}</span>
          </div>
          <div>
            <span className="k">Footprint left</span>
            <span className="v">{score.inquiryLogged ? "Yes (hard)" : "None (soft check)"}</span>
          </div>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 14 }}>
        A soft check like this never appears on your record. Applying for a loan is a hard inquiry
        and does.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        <button className="btn btn-ghost" onClick={onRecheck}>
          Check again
        </button>
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}
