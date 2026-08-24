/**
 * IdentityProvider — the BankID port.
 *
 * BankID does two distinct jobs in a lending flow:
 *   1. `startAuth` — prove who you are. Yields a TRUSTED personal number.
 *   2. `startSign` — legally sign the credit agreement. `userVisibleData`
 *      shows the actual terms on the customer's phone, and the returned
 *      signature is the evidence that they agreed to them.
 *
 * Behind an interface because:
 *   * the real thing needs certificates + the BankID test app;
 *   * it makes the whole flow testable without a vendor relationship.
 */

export type BankIdPurpose = "AUTH" | "SIGN";

export interface StartResult {
  orderRef: string;
  autoStartToken: string;
  /** v6 returns these for the animated QR (rotates each second, anti-phishing). */
  qrStartToken?: string;
  qrStartSecret?: string;
}

export interface CompletionData {
  user: {
    personalNumber: string;
    name: string;
    givenName: string;
    surname: string;
  };
  device?: { ipAddress: string };
  /** Base64 signature. Regulatory evidence — persist it, never recompute it. */
  signature: string;
  ocspResponse: string;
}

export type CollectResult =
  | { status: "pending"; hintCode: string; orderRef: string }
  | { status: "complete"; orderRef: string; completionData: CompletionData }
  | { status: "failed"; hintCode: string; orderRef: string };

export interface StartAuthInput {
  endUserIp: string;
}

export interface StartSignInput {
  endUserIp: string;
  /** The text rendered on the customer's phone. Put the real loan terms here. */
  userVisibleData: string;
  personalNumber?: string;
}

export interface IdentityProvider {
  startAuth(input: StartAuthInput): Promise<StartResult>;
  startSign(input: StartSignInput): Promise<StartResult>;
  collect(orderRef: string): Promise<CollectResult>;
  cancel(orderRef: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Fake
// ---------------------------------------------------------------------------

interface FakeOrder {
  orderRef: string;
  purpose: BankIdPurpose;
  personalNumber: string;
  collectsRemaining: number;
  cancelled: boolean;
  userVisibleData?: string;
}

export interface FakeIdentityOptions {
  /** How many collect() calls before the order completes — simulates the user. */
  collectsUntilComplete?: number;
  /** Personal number the fake "user" authenticates as. */
  personalNumber?: string;
  latencyMs?: number;
}

/**
 * In-memory BankID.
 *
 * Deliberately models the *shape* of the real protocol — an order that stays
 * `pending` across several polls before completing — because that pending
 * window is what the UI has to handle correctly. A fake that returned
 * `complete` immediately would hide the only hard part.
 */
export class FakeIdentityProvider implements IdentityProvider {
  private orders = new Map<string, FakeOrder>();
  private readonly collectsUntilComplete: number;
  private readonly personalNumber: string;
  private readonly latencyMs: number;

  constructor(opts: FakeIdentityOptions = {}) {
    this.collectsUntilComplete = opts.collectsUntilComplete ?? 2;
    this.personalNumber = opts.personalNumber ?? "199001019876";
    this.latencyMs = opts.latencyMs ?? 0;
  }

  async startAuth(_input: StartAuthInput): Promise<StartResult> {
    return this.start("AUTH");
  }

  async startSign(input: StartSignInput): Promise<StartResult> {
    return this.start("SIGN", input.userVisibleData, input.personalNumber);
  }

  private async start(
    purpose: BankIdPurpose,
    userVisibleData?: string,
    personalNumber?: string,
  ): Promise<StartResult> {
    await this.delay();
    const orderRef = `fake-${purpose.toLowerCase()}-${crypto.randomUUID()}`;
    this.orders.set(orderRef, {
      orderRef,
      purpose,
      personalNumber: personalNumber ?? this.personalNumber,
      collectsRemaining: this.collectsUntilComplete,
      cancelled: false,
      userVisibleData,
    });
    return {
      orderRef,
      autoStartToken: crypto.randomUUID(),
      qrStartToken: crypto.randomUUID(),
      qrStartSecret: crypto.randomUUID(),
    };
  }

  async collect(orderRef: string): Promise<CollectResult> {
    await this.delay();
    const order = this.orders.get(orderRef);
    if (!order) return { status: "failed", hintCode: "noSuchOrder", orderRef };
    if (order.cancelled) return { status: "failed", hintCode: "userCancel", orderRef };

    if (order.collectsRemaining > 0) {
      order.collectsRemaining -= 1;
      return {
        status: "pending",
        hintCode: order.collectsRemaining === this.collectsUntilComplete - 1
          ? "outstandingTransaction"
          : "userSign",
        orderRef,
      };
    }

    return {
      status: "complete",
      orderRef,
      completionData: {
        user: {
          personalNumber: order.personalNumber,
          name: "Test Testsson",
          givenName: "Test",
          surname: "Testsson",
        },
        device: { ipAddress: "127.0.0.1" },
        signature: Buffer.from(
          `fake-signature:${order.purpose}:${order.userVisibleData ?? ""}`,
        ).toString("base64"),
        ocspResponse: Buffer.from("fake-ocsp").toString("base64"),
      },
    };
  }

  async cancel(orderRef: string): Promise<void> {
    const order = this.orders.get(orderRef);
    if (order) order.cancelled = true;
  }

  private delay(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

// ---------------------------------------------------------------------------
// Real BankID (the `bankid` npm package)
// ---------------------------------------------------------------------------

export interface RealBankIdOptions {
  production: boolean;
  pfx?: string;
  passphrase?: string;
}

/**
 * Adapter over the open-source `bankid` npm package.
 *
 * Imported dynamically so the repo installs and runs with no certificates and
 * no OpenSSL configuration. Only loaded when USE_REAL_BANKID=true.
 *
 * Heads-up: on Node 17+ the bundled legacy test certs hit OpenSSL 3 errors.
 * Either supply modernised certs or run node with --openssl-legacy-provider.
 */
export class BankIdIdentityProvider implements IdentityProvider {
  private clientPromise: Promise<any> | null = null;

  constructor(private readonly opts: RealBankIdOptions) {}

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // Indirect specifier on purpose: `bankid` is an optionalDependency, so
        // the repo must typecheck and run whether or not it is installed. A
        // literal import() would make TS demand the module at build time.
        const specifier = "bankid";
        const mod: any = await import(specifier).catch(() => {
          throw new Error(
            "USE_REAL_BANKID=true but the 'bankid' package is not installed. " +
              "Run: pnpm add bankid --filter @refi/adapters",
          );
        });
        const Ctor = mod.BankIdClientV6 ?? mod.BankIdClient;
        return new Ctor({
          production: this.opts.production,
          ...(this.opts.pfx ? { pfx: this.opts.pfx } : {}),
          ...(this.opts.passphrase ? { passphrase: this.opts.passphrase } : {}),
        });
      })();
    }
    return this.clientPromise;
  }

  async startAuth(input: StartAuthInput): Promise<StartResult> {
    const client = await this.client();
    const res = await client.authenticate({ endUserIp: input.endUserIp });
    return {
      orderRef: res.orderRef,
      autoStartToken: res.autoStartToken,
      qrStartToken: res.qrStartToken,
      qrStartSecret: res.qrStartSecret,
    };
  }

  async startSign(input: StartSignInput): Promise<StartResult> {
    const client = await this.client();
    const res = await client.sign({
      endUserIp: input.endUserIp,
      userVisibleData: input.userVisibleData,
      ...(input.personalNumber ? { personalNumber: input.personalNumber } : {}),
    });
    return {
      orderRef: res.orderRef,
      autoStartToken: res.autoStartToken,
      qrStartToken: res.qrStartToken,
      qrStartSecret: res.qrStartSecret,
    };
  }

  async collect(orderRef: string): Promise<CollectResult> {
    const client = await this.client();
    const res = await client.collect({ orderRef });

    if (res.status === "complete") {
      return { status: "complete", orderRef, completionData: res.completionData };
    }
    if (res.status === "failed") {
      return { status: "failed", hintCode: res.hintCode ?? "unknown", orderRef };
    }
    return { status: "pending", hintCode: res.hintCode ?? "outstandingTransaction", orderRef };
  }

  async cancel(orderRef: string): Promise<void> {
    const client = await this.client();
    await client.cancel({ orderRef });
  }
}
