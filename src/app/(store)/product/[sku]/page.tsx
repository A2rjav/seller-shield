import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import ProductBuy from "@/components/ProductBuy";
import { getProduct } from "@/lib/catalog";
import { getPaypalConfig } from "@/lib/env";
import { formatMoney } from "@/lib/format";
import { STORE_POLICY } from "@/lib/store-policy";

export const dynamic = "force-dynamic";

function clientId(): string | null {
  try {
    return getPaypalConfig().clientId; // public id only; the secret never leaves the server
  } catch {
    return null;
  }
}

export default async function ProductPage({ params }: { params: Promise<{ sku: string }> }) {
  const { sku } = await params;
  const product = getProduct(sku);
  if (!product) notFound();

  return (
    <div>
      <Link href="/" className="text-sm text-muted hover:text-accent">
        &larr; All pieces
      </Link>
      <div className="mt-6 grid gap-10 md:grid-cols-2 md:gap-14">
        <div className="overflow-hidden rounded-sm border border-line bg-card">
          <Image src={product.imageUrl} alt={product.name} width={800} height={800} unoptimized priority className="aspect-square w-full object-cover" />
        </div>
        <div>
          <h1 className="font-display text-3xl text-green sm:text-4xl">{product.name}</h1>
          <p className="mt-2 text-lg text-muted">{formatMoney(product.priceCents)}</p>
          <p className="mt-6 leading-relaxed">{product.description}</p>
          <p className="mt-3 text-sm text-muted">Made by hand by Maya. Ships from Portland, Oregon.</p>

          <div className="mt-8 border-t border-line pt-6">
            <ProductBuy sku={product.sku} priceCents={product.priceCents} clientId={clientId()} />
          </div>

          <div className="mt-8 rounded-sm border border-line bg-card p-4 text-sm leading-relaxed">
            <h2 className="font-display text-base text-green">Shop policy</h2>
            <p className="mt-2">
              <span className="font-medium">Returns.</span> {STORE_POLICY.returns}
            </p>
            <p className="mt-1">
              <span className="font-medium">Shipping.</span> {STORE_POLICY.shipping}
            </p>
            <p className="mt-2 text-xs text-muted">By paying you agree to this policy (version {STORE_POLICY.version}).</p>
          </div>
        </div>
      </div>
    </div>
  );
}
