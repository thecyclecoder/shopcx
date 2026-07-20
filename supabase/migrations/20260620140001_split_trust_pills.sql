-- One-time split of existing products' trust-pill arrays into individual items.
-- Some rows stored comma-joined values as a SINGLE array element
-- (e.g. certifications = {"Non-GMO, 3rd Party Tested, Made in USA"}). The
-- storefront TrustChipRow renders one chip per element, so those showed as a
-- single run-on chip. This splits every element on commas, trims whitespace, and
-- drops empties, preserving original order. Idempotent: a comma-free element
-- splits to itself, and the `IS DISTINCT FROM` guard skips already-clean rows,
-- so re-running changes nothing. Going forward, the box seed flow writes these
-- as individual items via saveTrustPills (src/lib/product-intelligence/seed-tools.ts).

UPDATE public.products p
SET certifications = sub.arr
FROM (
  SELECT prod.id,
         array_agg(btrim(part) ORDER BY e.elem_ord, s.part_ord) AS arr
  FROM public.products prod,
       LATERAL unnest(prod.certifications) WITH ORDINALITY AS e(elem, elem_ord),
       LATERAL unnest(string_to_array(e.elem, ',')) WITH ORDINALITY AS s(part, part_ord)
  WHERE btrim(s.part) <> ''
  GROUP BY prod.id
) sub
WHERE p.id = sub.id
  AND p.certifications IS DISTINCT FROM sub.arr;

UPDATE public.products p
SET allergen_free = sub.arr
FROM (
  SELECT prod.id,
         array_agg(btrim(part) ORDER BY e.elem_ord, s.part_ord) AS arr
  FROM public.products prod,
       LATERAL unnest(prod.allergen_free) WITH ORDINALITY AS e(elem, elem_ord),
       LATERAL unnest(string_to_array(e.elem, ',')) WITH ORDINALITY AS s(part, part_ord)
  WHERE btrim(s.part) <> ''
  GROUP BY prod.id
) sub
WHERE p.id = sub.id
  AND p.allergen_free IS DISTINCT FROM sub.arr;
