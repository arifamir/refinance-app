/**
 * StatementOcr — reads a photographed loan/credit-card statement.
 *
 * In production this is a slow, CPU-heavy vision call. That latency is the
 * clearest justification for pushing it onto a queue: nobody should hold an
 * HTTP connection open on a mobile network while it runs.
 */

export interface ExtractedStatement {
  lender: string;
  balanceMinor: number;
  aprBps: number;
  /** 0..1. Below the threshold, route to manual review rather than guessing. */
  confidence: number;
}

export interface StatementOcr {
  extract(input: { fileRef: string; applicationId: string }): Promise<ExtractedStatement>;
}

const LENDERS = [
  "Nordax Bank",
  "Resurs Bank",
  "Ikano Bank",
  "Marginalen Bank",
  "Klarna",
  "Santander Consumer Bank",
];

/**
 * Deterministic fake OCR — output derives from the fileRef, so re-running a
 * job produces identical extraction. Non-determinism here would make the
 * idempotency guarantees untestable.
 *
 * Force an outcome via the fileRef:
 *   contains "lowconf" -> confidence 0.4 (manual review path)
 *   contains "fail"    -> throws (watch BullMQ retry)
 *
 * A `<lender-slug>__` prefix pins the extracted lender, so when the client
 * lets the customer pick their current lender first, the OCR result agrees
 * with what they chose instead of contradicting it.
 */
export class FakeStatementOcr implements StatementOcr {
  constructor(private readonly latencyMs = 0) {}

  async extract(input: { fileRef: string; applicationId: string }): Promise<ExtractedStatement> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    if (input.fileRef.includes("fail")) {
      throw new Error(`OCR failed to read statement ${input.fileRef}`);
    }

    const seed = hash(input.fileRef);

    // 15 000 – 95 000 kr outstanding
    const balanceMinor = (15_000 + (seed % 80_000)) * 100;
    // 18.00% – 29.95% — the expensive credit worth refinancing
    const aprBps = 1_800 + (seed % 1_196);
    const confidence = input.fileRef.includes("lowconf") ? 0.4 : 0.92;

    return {
      lender: lenderFromRef(input.fileRef) ?? LENDERS[seed % LENDERS.length]!,
      balanceMinor,
      aprBps,
      confidence,
    };
  }
}

/** "resurs-bank__statement.jpg" -> "Resurs Bank" */
function lenderFromRef(fileRef: string): string | null {
  const marker = fileRef.indexOf("__");
  if (marker <= 0) return null;

  return fileRef
    .slice(0, marker)
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
