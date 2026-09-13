export type ServerRegion = { location: string | null; country: string | null };

// Public provider locations; private host mappings arrive from local server configuration.
const datacenters: Record<string, { city:string; country:string }> = {
  nbg1: {city:"Nuremberg",country:"DE"},
  hel1: {city:"Helsinki",country:"FI"},
};
export function serverRegion({location,configured}: {
  location:string|null;configured?:ServerRegion|null;
}):ServerRegion {
  if(location) {
    const dc=datacenters[location.trim().toLowerCase().split("-")[0]!];
    return {location:dc?`${dc.city} · ${location}`:location,country:dc?.country ?? null};
  }
  return configured ?? {location:null,country:null};
}

export function countryFlag(country:string|null):string|null {
  const code=country?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map(c=>127397+c.charCodeAt(0))) : null;
}

export function countryName(country:string|null):string|null {
  return country ? new Intl.DisplayNames(["en"],{type:"region"}).of(country) ?? country : null;
}
