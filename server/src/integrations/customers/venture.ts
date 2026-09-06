/**
 * WHICH BUSINESS A CASE BELONGS TO, and the two rules that are allowed to
 * decide it.
 *
 * `venture_links` is the only place on this box where "this thing is that
 * business" is written down, and for Stripe its entity is a PRODUCT NAME —
 * see ventures/entities.ts, which enumerates products rather than
 * subscriptions because a venture sells a product and a subscription is one
 * customer's copy of it. So attribution here is a join through the product,
 * and everything below is about what to do when that join cannot be made.
 *
 * RULE ONE — THE PRODUCT. A subscription carries its product name in
 * stripe_subscriptions.product; an invoice and an event carry a subscription
 * id; so all three reach a venture through one lookup. This is the only rule
 * that is evidence.
 *
 * RULE TWO — THE SOLE VENTURE, and it is a fallback with a fence around it. A
 * dispute is opened against a CHARGE, and a charge has no product on it —
 * establishing one would cost a charge fetch, then a payment-intent fetch,
 * then an invoice fetch, per dispute, and would still fail for every one-off
 * payment. So where every Stripe link on this box points at ONE venture, that
 * venture is used, because on a single-business install the answer is not in
 * doubt. Where two ventures sell through the same Stripe account it returns
 * null and the document says the case is unattributed.
 *
 * NULL IS NEVER "THE FIRST VENTURE". An unattributed case is a real state and
 * it appears in the queue, at the top if its deadline says so; what it does
 * not do is put another business's name on somebody's churn.
 */
import { db } from "../../db.ts";
import { linkIndex, normaliseEntity } from "../ventures/links.ts";

export type VentureMap = {
  /** Product name (lowercased) → venture id. */
  byProduct: Map<string, string>;
  /** Subscription id → venture id, resolved through the product. */
  bySubscription: Map<string, string>;
  /** The one venture every Stripe link points at, or null. */
  sole: string | null;
  /** How many distinct ventures have a Stripe link. Published so a document
   *  can say why a dispute is unattributed rather than leaving a blank. */
  ventures: number;
};

/**
 * Built once per pass and once per request rather than cached.
 *
 * It is three indexed SELECTs over tables measured in hundreds of rows, and a
 * cache here would be a cache of the owner's link decisions — which are
 * exactly the thing that changes the moment somebody opens the venture map to
 * fix an attribution they just saw was wrong.
 */
export function ventureMap(): VentureMap {
  /* THE SAME READER FINANCE USES, so a product linked with different
     capitalisation than Stripe stores it with cannot attribute a dispute here
     and produce no revenue line there. Where two ventures are linked to one
     product `linkIndex` lists both and this takes the first, which is the
     venture `ventureOfEntity` would also name. */
  const index = linkIndex("stripe");
  const byProduct = new Map([...index].map(([entity, ids]) => [entity, ids[0]!]));

  const ventures = new Set([...index.values()].flat());
  const sole = ventures.size === 1 ? [...ventures][0]! : null;

  const bySubscription = new Map<string, string>();
  if (byProduct.size) {
    const subs = db
      .prepare("SELECT id, product FROM stripe_subscriptions WHERE product IS NOT NULL")
      .all() as unknown as { id: string; product: string }[];
    for (const s of subs) {
      const v = byProduct.get(normaliseEntity(s.product));
      if (v) bySubscription.set(s.id, v);
    }
  }

  return { byProduct, bySubscription, sole, ventures: ventures.size };
}

/** Rule one, for anything that names a subscription. */
export const ventureOfSubscription = (m: VentureMap, subscription: string | null) =>
  subscription ? (m.bySubscription.get(subscription) ?? null) : null;

/** Rule one, for anything that names a product. */
export const ventureOfProduct = (m: VentureMap, product: string | null) =>
  m.byProduct.get(normaliseEntity(product)) ?? null;

/** Rule two. Only ever reached where rule one had nothing to work with. */
export const soleVenture = (m: VentureMap) => m.sole;
