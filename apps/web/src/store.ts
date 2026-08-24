/**
 * Apply-flow wizard state.
 *
 * Eight screens accumulating answers, with a back stack. Zustand rather than
 * prop-drilling, and persisted so a refresh mid-quiz doesn't wipe the customer's
 * progress.
 *
 * STORAGE CHOICE IS DELIBERATE — sessionStorage, not localStorage.
 *
 * These answers are financial PII: income, household composition, number of
 * children, contact details. localStorage would leave that on the device
 * indefinitely, readable by any XSS and still present on a shared computer
 * days later. sessionStorage scopes it to the tab and dies when it closes.
 * `reset()` then purges it the moment the server has the data.
 *
 * The client holds a DRAFT; the server receives one atomic payload. That
 * mirrors the API design — a half-written affordability assessment is worse
 * than none, because it looks like an assessment.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Stage =
  | "lender"
  | "upload"
  | "cart"
  | "kalpIntro"
  | "accommodation"
  | "spouse"
  | "kids"
  | "income"
  | "source"
  | "debt"
  | "contact"
  | "leadCaptured" // anonymous quiz done — hand off to the authenticated app
  | "app"; // BankID claimed the lead; the server drives from here

/** Which statement the OCR worker should "see" — a demo affordance. */
export type Quality = "clean" | "lowconf" | "fail";

export interface Answers {
  ownsAccommodation?: boolean;
  hasSpouse?: boolean;
  numberOfChildren?: number;
  monthlyIncomeGrossMinor?: number;
  incomeSource?: string;
  monthlyDebtPaymentMinor?: number;
}

interface WizardState {
  applicationId: string | null;
  /** Capability token for the anonymous quiz phase. */
  draftToken: string | null;
  /** One-time handoff token minted when the quiz becomes a lead. */
  claimToken: string | null;
  stage: Stage;
  /** Back stack. Their flow has a back arrow on every question. */
  history: Stage[];
  /** Lender currently being uploaded for. */
  lender: string | null;
  quality: Quality;
  answers: Answers;
  email: string;
  phone: string;

  setApplicationId: (id: string | null) => void;
  setDraft: (applicationId: string, draftToken: string) => void;
  setClaimToken: (claimToken: string) => void;
  goTo: (stage: Stage) => void;
  back: () => void;
  setLender: (lender: string | null) => void;
  setQuality: (quality: Quality) => void;
  answer: <K extends keyof Answers>(key: K, value: Answers[K]) => void;
  setContact: (email: string, phone: string) => void;
  reset: () => void;
}

const initial = {
  applicationId: null,
  draftToken: null,
  claimToken: null,
  stage: "lender" as Stage,
  history: [] as Stage[],
  lender: null,
  quality: "clean" as Quality,
  answers: {} as Answers,
  email: "",
  phone: "",
};

export const useWizard = create<WizardState>()(
  persist(
    (set) => ({
      ...initial,

      setApplicationId: (applicationId) => set({ applicationId }),
      setDraft: (applicationId, draftToken) => set({ applicationId, draftToken }),
      setClaimToken: (claimToken) => set({ claimToken }),

      goTo: (stage) =>
        set((s) => ({ stage, history: [...s.history, s.stage] })),

      back: () =>
        set((s) => {
          const history = [...s.history];
          const previous = history.pop();
          return previous ? { stage: previous, history } : {};
        }),

      setLender: (lender) => set({ lender }),
      setQuality: (quality) => set({ quality }),

      answer: (key, value) =>
        set((s) => ({ answers: { ...s.answers, [key]: value } })),

      setContact: (email, phone) => set({ email, phone }),

      /** Called once the server holds the answers — leaves no PII behind. */
      reset: () => set({ ...initial, answers: {} }),
    }),
    {
      name: "refi-apply-draft",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);

/** Every KALP answer present? Gates the submit. */
export function isKalpComplete(answers: Answers): boolean {
  return (
    answers.ownsAccommodation !== undefined &&
    answers.hasSpouse !== undefined &&
    answers.numberOfChildren !== undefined &&
    answers.monthlyIncomeGrossMinor !== undefined &&
    answers.incomeSource !== undefined &&
    answers.monthlyDebtPaymentMinor !== undefined
  );
}

/** Fraction complete, for the progress rail. */
export const STAGE_PROGRESS: Record<Stage, number> = {
  lender: 0.06,
  upload: 0.14,
  cart: 0.22,
  kalpIntro: 0.3,
  accommodation: 0.38,
  spouse: 0.46,
  kids: 0.54,
  income: 0.62,
  source: 0.7,
  debt: 0.78,
  contact: 0.86,
  leadCaptured: 0.9,
  app: 0.92,
};
