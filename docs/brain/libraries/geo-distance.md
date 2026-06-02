# libraries/geo-distance

Haversine distance + US zip centroid lookup via `zipcodes` package. Powers `address_distance` fraud rule.

**File:** `src/lib/geo-distance.ts`

## File header

```
Geo-distance calculation using US zip code centroids + Haversine formula
Uses the `zipcodes` npm package for lat/lng lookups (~42K US zip codes)
```

## Exports

### `haversineDistance` — function

```ts
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number,) : number
```

### `zipToLatLng` — function

```ts
function zipToLatLng(zip: string) :
```

### `zipDistance` — function

```ts
function zipDistance(zip1: string, zip2: string) : number | null
```

### `extractZip` — function

```ts
function extractZip(address: { zip?: string; postal_code?: string } | null) : string | null
```

## Callers

- `src/lib/fraud-detector.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
