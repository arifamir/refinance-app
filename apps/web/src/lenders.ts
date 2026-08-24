/** Swedish consumer-credit providers, grouped the way an apply flow presents them. */

export interface Lender {
  name: string;
  colour: string;
  categories: Array<"popular" | "private" | "card" | "installment" | "car">;
}

export const LENDERS: Lender[] = [
  { name: "Klarna", colour: "#e6a2b8", categories: ["popular", "card", "installment"] },
  { name: "Northmill Bank", colour: "#9d8ec9", categories: ["popular", "private"] },
  { name: "Resurs Bank", colour: "#5da9dd", categories: ["popular", "card", "installment"] },
  { name: "Qliro", colour: "#1d1d1b", categories: ["popular", "card", "installment"] },
  { name: "Nordax Bank", colour: "#2f6f5e", categories: ["popular", "private"] },
  { name: "Ikano Bank", colour: "#4a6fd4", categories: ["private", "card"] },
  { name: "Marginalen Bank", colour: "#c4562f", categories: ["private", "card"] },
  { name: "Santander Consumer Bank", colour: "#c8102e", categories: ["private", "car"] },
  { name: "Bank Norwegian", colour: "#0f2b5b", categories: ["card", "private"] },
  { name: "Svea Bank", colour: "#1f7a4d", categories: ["private", "installment"] },
  { name: "Lendify", colour: "#7a5cc4", categories: ["private"] },
  { name: "Wasa Kredit", colour: "#b8860b", categories: ["car", "installment"] },
];

export const CATEGORIES = [
  { key: "popular", label: "Popular" },
  { key: "private", label: "Private loans" },
  { key: "card", label: "Credit card" },
  { key: "installment", label: "Installment" },
  { key: "car", label: "Car loan" },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]["key"];

/** "Resurs Bank" -> "RB", "Klarna" -> "K" */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

/** "Resurs Bank" -> "resurs-bank", which the OCR fake reads back as the lender. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Existing monthly debt-service buckets.
 *
 * Buckets rather than a free number because nobody recalls the exact figure.
 * The value sent is the TOP of the range — assessing on the conservative end
 * means an imprecise answer can only make us stricter, never laxer.
 *
 * Mirrors DEBT_BUCKETS in @refi/domain; duplicated here rather than imported
 * so the browser bundle never pulls in server-side domain code.
 */
export const DEBT_BUCKETS = [
  { label: "0 – 1 000 kr", maxMinor: 100_000 },
  { label: "1 000 – 2 000 kr", maxMinor: 200_000 },
  { label: "2 000 – 4 000 kr", maxMinor: 400_000 },
  { label: "4 000 – 6 000 kr", maxMinor: 600_000 },
  { label: "6 000 – 10 000 kr", maxMinor: 1_000_000 },
  { label: "More than 10 000 kr", maxMinor: 1_500_000 },
] as const;
