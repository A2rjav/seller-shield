import { describe, it, expect } from "vitest";
import { products } from "@/lib/catalog";

describe("catalog", () => {
  it("has 5 products incl. the $60 hoops and one $850 item", () => {
    expect(products).toHaveLength(5);
    expect(products.find((p) => p.sku === "silver-hoops")?.priceCents).toBe(6000);
    expect(products.some((p) => p.priceCents === 85000)).toBe(true);
    for (const p of products) expect(p.costCents).toBeLessThan(p.priceCents);
  });
});
