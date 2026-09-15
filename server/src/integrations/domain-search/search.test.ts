import test from "node:test";
import assert from "node:assert/strict";
import { bulkNames, normalizeName, parseTlds, searchLabel } from "./input.ts";
import { checkProvider, parseResults } from "./providers.ts";
import { domainSearch } from "./routes.ts";
const now = "2026-09-15T12:00:00Z";

test("domain inputs accept international and compound names, deduplicate and reject URLs", () => {
  assert.deepEqual(bulkNames("CEDAR.com\ncedar.com;shop.co.uk bücher.de"), ["cedar.com", "shop.co.uk", "xn--bcher-kva.de"]);
  assert.equal(normalizeName("Cedar。COM."), "cedar.com");
  assert.equal(searchLabel("bücher"), "xn--bcher-kva");
  for (const input of ["https://cedar.com", "cedar.com/path", "name@cedar.com", "cedar..com", "-bad.com", "bad-.com", "a".repeat(64)+".com", "cedar.com?token=secret", "127.0.0.1"])
    assert.throws(() => bulkNames(input));
  assert.throws(() => searchLabel("cedar.com"));
  assert.throws(() => bulkNames("bare-name"));
  assert.throws(() => bulkNames(Array.from({length:201}, (_, i) => `a${i}.com`).join("\n")), /200/);
  assert.throws(() => bulkNames(""));
});

test("TLD coverage comes from the directory, including IDNs, not the priority order", () => {
  const list = ["COM", "NET", "XN--P1AI", ...Array.from({length:110},(_,i)=>`EXT${i}`)];
  const parsed = parseTlds("# Version 1\n" + list.join("\n") + "\nCOM\n<script>");
  assert.equal(parsed.length, list.length);
  assert.equal(parsed[0], "com");
  assert.ok(parsed.includes("xn--p1ai"));
  assert.throws(() => parseTlds("<html>error</html>"));
});

test("Spaceship distinguishes taken, unsupported, unknown and premium availability", () => {
  const names = ["taken.com", "free.com", "premium.com", "restricted.google", "missing.com", "unknown.com"];
  const result = parseResults("spaceship", {domains:[
    {domain:names[0],result:"taken"}, {domain:names[1],result:"available"},
    {domain:names[2],result:"available",premiumPricing:[{operation:"register",price:100,currency:"USD"}]},
    {domain:names[3],result:"tldNotSupported"}, {domain:names[5],result:"registryBusy"},
  ]}, names, now);
  assert.deepEqual(result.map(r=>r.status), ["unavailable","available","available","unsupported","unknown","unknown"]);
  assert.equal(result[2]!.premium,true);
  assert.equal(result[1]!.checkedAt,now);
});

test("Dynadot does not turn missing, errored or low-confidence responses into availability", () => {
  const names = ["yes.com","no.com","busy.com","cached.com","unsupported.aaa","missing.com"];
  const results = parseResults("dynadot", {data:{domain_result_list:[
    {domain_name:names[0],available:"Yes",premium:"yes"},
    {domain_name:names[1],available:false},
    {domain_name:names[2],available:true,details_error_message:"busy"},
    {domain_name:names[3],available:true,confidence:"low"},
    {domain_name:names[4],details_error_message:"Unsupported domain type"},
  ]}},names,now);
  assert.deepEqual(results.map(r=>r.status),["available","unavailable","unknown","unknown","unsupported","unknown"]);
  assert.equal(results[0]!.premium,true);
  assert.throws(()=>parseResults("dynadot",{},names,now));
});

test("registrar requests only call search endpoints and provider errors never leak credentials", async t => {
  const calls: {url:string; init?:RequestInit}[]=[];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({url,init});
    return new Response(JSON.stringify({domains:[{domain:"free.com",result:"available"}],code:200,data:{domain_result_list:[{domain_name:"free.com",available:"Yes"}]}}),{status:200});
  });
  const signal = new AbortController().signal;
  await checkProvider("spaceship",{key:"private-key",secret:"private-secret"},["free.com"],signal);
  await checkProvider("dynadot",{key:"private-key",secret:"private-secret"},["free.com"],signal);
  assert.equal(calls[0]!.url,"https://spaceship.dev/api/v1/domains/available");
  assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)),{domains:["free.com"]});
  assert.match(calls[1]!.url,/\/bulk_search\?/);
  assert.ok(!calls.some(c=>c.url.includes("private-")));
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({message:"private-key private-secret"}),{status:401}));
  await assert.rejects(checkProvider("spaceship",{key:"private-key",secret:"private-secret"},["free.com"],signal), error=>
    error instanceof Error && /refused/.test(error.message) && !/private-/.test(error.message));
});

test("search routes validate before network access and return deduplicated plans", async t => {
  t.mock.method(globalThis,"fetch",()=>{throw new Error("Unexpected network call");});
  const request=(body:unknown)=>domainSearch.request('/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const valid=await request({mode:"bulk",input:"cedar.com\nCEDAR.com\nshop.co.uk"});
  assert.equal(valid.status,200);
  assert.deepEqual(await valid.json(),{domains:["cedar.com","shop.co.uk"]});
  assert.equal((await request({mode:"all",input:"bad.com"})).status,400);
  assert.equal((await request({mode:"other",input:"cedar"})).status,400);
  assert.equal((await domainSearch.request('/check?accountId=1&domains=https://example.com')).status,400);
  assert.equal((await domainSearch.request('/check?accountId=no&domains=example.com')).status,400);
});

test("search service caches by account, bounds batches and prevents concurrent requests", async t => {
  const {db} = await import('../../db.ts');
  const {create,writeCredentials} = await import('../../accounts.ts');
  const {searchBatch,SearchBusy} = await import('./service.ts');
  db.prepare("INSERT OR IGNORE INTO plugins (id,connected,updated_at) VALUES ('spaceship',1,?)").run(now);
  const a=create('spaceship','Search test'), b=create('spaceship','Second search test');
  for(const account of [a,b]) writeCredentials(account,'spaceship',['key','secret'],{key:'test-key',secret:'test-secret'});
  let calls=0,release:(()=>void)|undefined;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    if(calls===1) await new Promise<void>(resolve=>{release=resolve;});
    return new Response(JSON.stringify({domains:[{domain:'free.com',result:'available'}]}));
  });
  const signal=new AbortController().signal;
  const first=searchBatch(a.id,['free.com'],signal);
  await assert.rejects(searchBatch(a.id,['free.com'],signal),SearchBusy);
  release!(); assert.equal((await first)[0]!.status,'available');
  t.mock.method(Date,'now',()=>Date.parse(now)+1_000_000_000_000);
  assert.equal((await searchBatch(a.id,['free.com'],signal))[0]!.status,'available');
  // Advance just past the cooldown, but inside the cache lifetime.
  const cachedTime=Date.now();t.mock.method(Date,'now',()=>cachedTime+2000);
  assert.equal((await searchBatch(a.id,['free.com'],signal))[0]!.status,'available');
  assert.equal(calls,2);
  await searchBatch(b.id,['free.com'],signal); assert.equal(calls,3);
  await assert.rejects(searchBatch(b.id,Array.from({length:21},(_,i)=>`a${i}.com`),signal),/20 names/);
});
