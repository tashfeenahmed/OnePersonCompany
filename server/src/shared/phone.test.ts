import { test } from "node:test";
import assert from "node:assert/strict";
import { cash, clock, dayName, duration, lanOnly, plainCause, price, relativeDay, someOf, when } from "./phone.ts";

test("prices read the way a person writes them", () => {
  assert.equal(price(19, "usd", "year", 1), "$19/yr");
  assert.equal(price(49, "EUR", "month"), "€49/mo");
  assert.equal(price(19.5, "gbp"), "£19.50");
  assert.equal(price(57, "usd", "month", 3), "$57 every 3 months");
  assert.equal(cash(19.53, "usd"), "$19.53");
  assert.equal(cash(17915.4, "usd"), "$17,915.40");
  assert.equal(cash(12, "chf"), "CHF 12");
  assert.equal(cash(-29, "usd"), "-$29");
});

test("times are local, short, and only as specific as they need to be", () => {
  const now = new Date("2026-09-24T21:40:00Z");
  assert.equal(clock("2026-09-24T21:32:00Z", "Europe/Dublin"), "10:32pm");
  assert.equal(clock("2026-09-24T00:05:00Z", "Europe/Dublin"), "1:05am");
  assert.equal(when("2026-09-24T21:32:00Z", "Europe/Dublin", now), "at 10:32pm");
  assert.equal(when("2026-09-23T08:00:00Z", "Europe/Dublin", now), "yesterday at 9:00am");
  assert.equal(when("2026-09-21T08:00:00Z", "Europe/Dublin", now), "on Mon 21 Sep at 9:00am");
  assert.equal(relativeDay("2026-09-25", now, "Europe/Dublin"), "tomorrow");
  assert.equal(dayName("2027-08-27", now, "UTC"), "Fri 27 Aug 2027");
});

test("durations and lists", () => {
  assert.equal(duration(3_840_000), "1 h 4 min");
  assert.equal(duration(12 * 60_000), "12 min");
  assert.equal(duration(400), "1 s");
  assert.equal(duration(null), null);
  assert.equal(someOf(["a", "b", "c", "d", "e"]), "a, b, c, +2 more");
  assert.equal(someOf(["a", "b", "c", "d"]), "a, b, c, d", "one more is named, not counted");
});

test("known causes are said in plain words; the rest are shortened, not dressed up", () => {
  const dell = "Could not reach Local · Dell 5820 (Dell 5820) at http://192.168.1.50:11434/v1/chat/completions (TypeError).";
  assert.deepEqual(plainCause(dell), { text: "couldn't reach Dell 5820, it may be switched off", known: true });
  assert.equal(plainCause("Hermes stopped mid-answer — Local · Dell 5820 could not be reached — fetch failed").text, "couldn't reach Dell 5820, it may be switched off");
  assert.equal(plainCause("tashfene@example.com: The scorer failed part-way: " + dell).text, "couldn't reach Dell 5820, it may be switched off");
  assert.equal(plainCause("interrupted by a restart").text, "it was cut off when OPC restarted");
  assert.equal(
    plainCause("The job ran out of time: its 7,200-second runtime limit ended before the work did.").text,
    "it hit its 2 h time limit (what it wrote so far is kept)",
  );
  assert.equal(plainCause("FreeLLMAPI (Hetzner box) did not answer within 120 seconds.").text, "FreeLLMAPI (Hetzner box) didn't answer within 2 min");
  assert.equal(plainCause("Hermes stopped mid-answer — Connection error.").text, "the connection to the model dropped mid-answer");
  const odd = plainCause("spec: The model could not produce a usable scene list.");
  assert.equal(odd.known, false);
  assert.equal(odd.text, "spec: The model could not produce a usable scene list.");
});

test("a LAN address is not a link a phone can open away from home", () => {
  assert.equal(lanOnly("http://192.168.1.17:8787"), true);
  assert.equal(lanOnly("http://localhost:8787"), true);
  assert.equal(lanOnly("https://opc.example.com"), false);
});
