/**
 * The two published documents, and the two ways each could quietly be wrong:
 * a price list read as free, and a cross rate computed the wrong way round.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, insertAccount, replaceDomains, upsertPlugin } from "../../db.ts";
import { parsePriceList } from "../../providers/dynadot.ts";
import { crossRate, parseEcb, referenceRates, storeReferenceRates, storeTldPrices, tldCandidates, tldPrice } from "./prices.ts";
import { seedDomains, type ExpenseRow } from "./expenses.ts";
import { convert, emptyTotals, addTo } from "./money.ts";

function reset() {
  db.exec("DELETE FROM finance_expenses; DELETE FROM finance_tld_prices; DELETE FROM finance_fx_rates; DELETE FROM domains;");
}

test("Dynadot's price list is read at this account's level, and an unreadable price is not a free TLD", () => {
  const list = parsePriceList({
    code: 200,
    data: {
      currency: "USD",
      price_level: "Regular Account",
      tld_price_list: [
        { tld: "co", all_years_renew_price: ["31.20", "62.40"] },
        { tld: ".ie", all_years_renew_price: "24.99" },
        { tld: "app", all_years_renew_price: [] },
        { tld: "dev", all_years_renew_price: null },
        { tld: "", all_years_renew_price: "9.99" },
      ],
    },
  });
  assert.deepEqual(list.prices, { co: 31.2, ie: 24.99 });
  assert.equal(list.priceLevel, "Regular Account");
  assert.throws(() => parsePriceList({ data: { currency: "EUR", tld_price_list: [{ tld: "co", all_years_renew_price: "1" }] } }), /EUR, not USD/);
  assert.throws(() => parsePriceList({ data: {} }), /tld_price_list/);
});

test("a second-level registry is asked for the pair before the bare code", () => {
  assert.deepEqual(tldCandidates("example.co.uk"), ["co.uk", "uk"]);
  assert.deepEqual(tldCandidates("example.ie"), ["ie"]);
  reset();
  storeTldPrices("dynadot", { prices: { "co.uk": 12, uk: 9, ie: 24.99 }, priceLevel: null, currency: "USD" }, "2026-09-07T00:00:00.000Z");
  assert.equal(tldPrice("example.co.uk")!.annual, 12);
  assert.equal(tldPrice("example.uk")!.annual, 9);
  assert.equal(tldPrice("example.ie")!.annual, 24.99);
  assert.equal(tldPrice("example.app"), null);
});

test("the seeder prices a Dynadot name from the list and leaves a Spaceship name unpriced", () => {
  reset();
  storeTldPrices("dynadot", { prices: { co: 31.2 }, priceLevel: "Regular Account", currency: "USD" }, "2026-09-07T00:00:00.000Z");
  /* `plugin_accounts` keys onto `plugins`, and a test database has not had
     either registrar through its manifest. */
  upsertPlugin("dynadot", true, null);
  upsertPlugin("spaceship", true, null);
  const dyn = insertAccount("dynadot", `dyn-${Date.now()}`);
  const ship = insertAccount("spaceship", `ship-${Date.now()}`);
  const row = (name: string, registrar: string) => ({
    name, registrar, expiresAt: "2027-01-01", registeredOn: null, autoRenew: true, locked: null, status: null, privacy: null, nameservers: null,
  });
  replaceDomains("dynadot", dyn, "dyn", [row("support-example.co", "Dynadot"), row("example.app", "Dynadot")]);
  replaceDomains("spaceship", ship, "ship", [row("example-app-8.example.test", "Spaceship")]);
  seedDomains();
  const rows = db.prepare("SELECT * FROM finance_expenses WHERE source = 'registrar' ORDER BY label").all() as unknown as ExpenseRow[];
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(by["support-example.co"]!.amount, 31.2);
  assert.equal(by["support-example.co"]!.currency, "USD");
  assert.match(by["support-example.co"]!.notes ?? "", /Dynadot's own renewal list for \.co at the Regular Account price level/);
  /* A TLD the list does not carry stays unpriced — never free. */
  assert.equal(by["example.app"]!.amount, null);
  assert.match(by["example.app"]!.notes ?? "", /does not carry this TLD/);
  /* Spaceship publishes nothing; the note says so rather than blaming the list. */
  assert.equal(by["example-app-8.example.test"]!.amount, null);
  assert.match(by["example-app-8.example.test"]!.notes ?? "", /No renewal price is published/);
});

test("the ECB file gives units per euro, and a cross rate goes through the euro", () => {
  const parsed = parseEcb(`<?xml version="1.0"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time='2026-09-05'>
    <Cube currency='USD' rate='1.1622'/>
    <Cube currency="GBP" rate="0.8654"/>
  </Cube></Cube>
</gesmes:Envelope>`);
  assert.equal(parsed.asOf, "2026-09-05");
  assert.deepEqual(parsed.rates, { USD: 1.1622, GBP: 0.8654 });
  assert.throws(() => parseEcb("<Cube/>"), /no dated Cube/);

  reset();
  storeReferenceRates(parsed, "2026-09-07T08:00:00.000Z");
  const ref = referenceRates()!;
  assert.equal(ref.asOf, "2026-09-05");
  /* €1 → $1.1622, and back; £1 → $ through the euro. */
  assert.equal(crossRate(ref, "EUR", "USD"), 1.1622);
  assert.ok(Math.abs(crossRate(ref, "USD", "EUR")! - 1 / 1.1622) < 1e-12);
  assert.ok(Math.abs(crossRate(ref, "GBP", "USD")! - 1.1622 / 0.8654) < 1e-12);
  assert.equal(crossRate(ref, "JPY", "USD"), null);
  assert.equal(crossRate(null, "EUR", "USD"), null);
});

test("a converted total says which rate it used", () => {
  const totals = addTo(addTo(emptyTotals(), "EUR", 100), "USD", 50);
  const ecb = convert(totals, "USD", [{ from: "EUR", to: "USD", rate: 1.1622, asOf: "2026-09-05", source: "ecb" }]);
  assert.ok(ecb && "amount" in ecb);
  assert.equal(ecb.amount, 166.22);
  assert.match(ecb.note, /ECB's daily reference rate of 2026-09-05/);
  const typed = convert(totals, "USD", [{ from: "EUR", to: "USD", rate: 1.1, asOf: null, source: "typed" }]);
  assert.ok(typed && "note" in typed);
  assert.match(typed.note, /typed on the Finance integration's page, not a rate fetched/);
});
