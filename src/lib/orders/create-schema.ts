import { z } from "zod";
import { getProduct } from "@/lib/catalog";

export const createOrderBody = z.object({
  items: z
    .array(
      z.object({
        sku: z.string().refine((s) => !!getProduct(s), "Unknown product"),
        qty: z.number().int().min(1).max(5),
      }),
    )
    .min(1)
    .max(10),
});
