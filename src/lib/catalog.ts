export type Product = {
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  costCents: number; // seller's cost of goods (~35% of price)
  imageUrl: string;
  kind: "physical";
};

const p = (sku: string, name: string, description: string, priceCents: number): Product => ({
  sku,
  name,
  description,
  priceCents,
  costCents: Math.round(priceCents * 0.35),
  imageUrl: `/products/${sku}.svg`,
  kind: "physical",
});

/** Juniper & Thread: Maya's handmade jewellery shop (fictional). */
export const products: Product[] = [
  p("silver-hoops", "Silver hoop earrings", "Hand-forged sterling silver hoops, lightweight and polished by hand.", 6000),
  p("juniper-pendant", "Juniper berry pendant", "Cast bronze pendant modelled on a juniper sprig, on an 18 inch chain.", 4800),
  p("woven-cuff", "Woven thread cuff", "Hand-woven waxed linen thread cuff with a brass clasp.", 2500),
  p("moonstone-ring", "Moonstone stacking ring", "Sterling silver band set with a natural rainbow moonstone.", 11800),
  p("heirloom-necklace", "Heirloom gold necklace", "14k gold-filled necklace with a hand-set sapphire, made to order.", 85000),
];

export function getProduct(sku: string): Product | undefined {
  return products.find((x) => x.sku === sku);
}
