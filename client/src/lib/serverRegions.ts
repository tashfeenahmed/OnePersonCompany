export type ServerRegion = { location: string | null; country: string | null };

// Region metadata from WorkDash's fleet inventory. Provider locations take
// precedence; the two non-Hetzner hosts must match BOTH address and hostname.
const datacenters: Record<string, { city:string; country:string }> = {
  nbg1: {city:"Nuremberg",country:"DE"},
  hel1: {city:"Helsinki",country:"FI"},
};
const otherHosts = [
  {address:"192.0.2.17",hostname:"raspberrypi",location:"Home · LAN",country:"GB"},
  {address:"192.0.2.185",hostname:"example-cloud-host",location:"Ashburn · us-ashburn-ad-2",country:"US"},
];

export function serverRegion({location,address,hostname}: {
  location:string|null;address:string|null;hostname:string|null;
}):ServerRegion {
  if(location) {
    const dc=datacenters[location.trim().toLowerCase().split("-")[0]!];
    return {location:dc?`${dc.city} · ${location}`:location,country:dc?.country ?? null};
  }
  const known=otherHosts.find(s=>s.address===address && s.hostname===hostname);
  return known?{location:known.location,country:known.country}:{location:null,country:null};
}

export function countryFlag(country:string|null):string|null {
  const code=country?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map(c=>127397+c.charCodeAt(0))) : null;
}

export function countryName(country:string|null):string|null {
  return country ? new Intl.DisplayNames(["en"],{type:"region"}).of(country) ?? country : null;
}
