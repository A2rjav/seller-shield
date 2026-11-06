import Image from "next/image";
import Link from "next/link";
import { products } from "@/lib/catalog";
import { formatMoney } from "@/lib/format";

export default function Home() {
  return (
    <>
      <section className="max-w-2xl">
        <p className="mb-4 text-xs uppercase tracking-[0.22em] text-accent">Small batch, made by hand</p>
        <h1 className="font-display text-4xl leading-tight text-green sm:text-6xl">
          Jewellery with a little bit of the woods in it.
        </h1>
        <p className="mt-6 text-lg leading-relaxed text-muted">
          I&apos;m Maya, and I make every piece at my bench in Portland, Oregon, from silver, bronze, linen thread and
          the odd stone I fall for. Each order is packed and posted by me, with tracking, within two business days.
        </p>
      </section>

      <section className="mt-14 sm:mt-20" aria-label="Shop">
        <ul className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <li key={p.sku}>
              <Link href={`/product/${p.sku}`} className="group block">
                <div className="overflow-hidden rounded-sm border border-line bg-card">
                  <Image
                    src={p.imageUrl}
                    alt={p.name}
                    width={400}
                    height={400}
                    unoptimized
                    className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]"
                  />
                </div>
                <div className="mt-4 flex items-baseline justify-between gap-4">
                  <h2 className="font-display text-xl text-green group-hover:text-accent">{p.name}</h2>
                  <span className="shrink-0 text-sm text-muted">{formatMoney(p.priceCents)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
