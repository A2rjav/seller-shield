export type StatusCopy = { kind: "paid" | "pending" | "failed"; eyebrow: string; headline: string; detail: string | null };

/** Buyer-facing wording for a stored order status. Anything but COMPLETED/PENDING is shown as not paid. */
export function statusCopy(status: string): StatusCopy {
  if (status === "COMPLETED") {
    return { kind: "paid", eyebrow: "Order confirmed", headline: "Thank you. Maya will pack this by hand.", detail: null };
  }
  if (status === "PENDING") {
    return { kind: "pending", eyebrow: "Payment pending", headline: "Thank you. Your payment is being confirmed by PayPal.", detail: null };
  }
  return {
    kind: "failed",
    eyebrow: "Payment not completed",
    headline: "Payment did not go through.",
    detail: "You have not been charged for this order. You are welcome to try again.",
  };
}
