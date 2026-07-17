/**
 * Guard tests for lib/stylistGuards.ts — the shared outfit-generation rules
 * used by BOTH the app (constants/api-client.ts) and the run-automations
 * edge function.
 *
 * Run: `npm run test:guards`
 * (bundles with esbuild and executes under node — no test framework needed)
 */
import {
  describeWeatherForStylist,
  dropColorClashes,
  dropFormalityOutliers,
  dropNearDuplicateOutfits,
  dropPatternOverload,
  enforceUserStyleMatch,
  filterClosetByOccasion,
  formalityRank,
  isLikelyNonWardrobeObject,
  isLowConfidenceClassification,
  isNearDuplicateOutfit,
  layerRank,
  normalizeFormality,
  normalizePattern,
  normalizeStyleTags,
  occasionTagForPhrase,
  orderOutfitLayers,
  outfitHonorsUserStyle,
  outfitOverlap,
  outfitStyleConflicts,
  primaryStyleFromTags,
  recentlySuggestedIds,
  rotationSortForPrompt,
  sanitizeOutfitSelection,
  spendCallBudget,
  StylistCallBudgetExhausted,
  userStyleMatchIds,
  type StylistCallBudget,
  type StylistItem,
} from "./stylistGuards";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log("FAIL: " + label);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const closet: StylistItem[] = [
  { id: "tee", category: "top", name: "White Tee", type: "t-shirt", seasons: ["all"], color: "white" },
  { id: "sweater1", category: "top", name: "Wool Sweater", type: "sweater", seasons: ["fall", "winter"], color: "cream" },
  { id: "sweater2", category: "top", name: "Cashmere Crewneck", type: "crewneck", seasons: ["fall", "winter"], color: "grey" },
  { id: "hoodie", category: "top", name: "Grey Hoodie", type: "hoodie", seasons: ["fall", "winter"], color: "grey" },
  { id: "tank", category: "top", name: "Black Tank", type: "tank", seasons: ["spring", "summer"], color: "black" },
  { id: "jeans", category: "bottom", name: "Blue Jeans", type: "jeans", seasons: ["all"], color: "denim" },
  { id: "shorts", category: "bottom", name: "Gym Shorts", type: "shorts", seasons: ["spring", "summer"], color: "black" },
  { id: "dress", category: "full body", name: "Cocktail Dress", type: "dress", seasons: ["all"], color: "black" },
  { id: "sneakers", category: "shoes", name: "White Sneakers", type: "sneakers", seasons: ["all"], color: "white" },
  { id: "heels", category: "shoes", name: "Black Heels", type: "heels", seasons: ["all"], color: "black" },
  { id: "coat", category: "outerwear", name: "Puffer Coat", type: "puffer", seasons: ["fall", "winter"], color: "navy" },
  { id: "bag", category: "bag", name: "Tote", type: "tote", seasons: ["all"], color: "tan" },
];

// ── sanitizeOutfitSelection: slot + season + knit guards ─────────────────────

let r = sanitizeOutfitSelection(["sweater1", "sweater2", "jeans", "sneakers"], closet, []);
assert(!(r.includes("sweater1") && r.includes("sweater2")), "no double sweaters");
assert(r.includes("jeans") && r.includes("sneakers"), "keeps rest of outfit");

r = sanitizeOutfitSelection(["hoodie", "sweater1", "jeans", "sneakers"], closet, []);
assert(!(r.includes("hoodie") && r.includes("sweater1")), "no hoodie+sweater stack");

r = sanitizeOutfitSelection(["tee", "sweater1", "jeans", "sneakers"], closet, []);
assert(r.includes("tee") && r.includes("sweater1"), "tee under sweater allowed");

r = sanitizeOutfitSelection(["dress", "jeans", "heels"], closet, []);
assert(r.includes("dress") && !r.includes("jeans"), "no bottoms with full-body");

r = sanitizeOutfitSelection(["tee", "jeans", "sneakers", "heels"], closet, []);
assert(r.filter((id) => id === "sneakers" || id === "heels").length === 1, "one pair of shoes");

r = sanitizeOutfitSelection(["sweater1", "tee", "jeans", "sneakers", "coat"], closet, [], 85);
assert(!r.includes("sweater1") && !r.includes("coat"), "hot day drops winter pieces");
assert(r.includes("tee"), "hot day keeps all-season tee");

r = sanitizeOutfitSelection(["tee", "shorts", "sneakers", "coat"], closet, [], 30);
assert(!r.includes("shorts"), "cold day drops summer shorts");
assert(r.includes("coat"), "cold day keeps coat");

r = sanitizeOutfitSelection(["tee", "jeans", "sneakers"], closet, ["sweater1"], 85);
assert(r.includes("sweater1"), "anchor forced in despite heat");

r = sanitizeOutfitSelection(["ghost-id", "tee", "jeans", "sneakers"], closet, []);
assert(!r.includes("ghost-id"), "hallucinated id dropped");

// ── formality validator ──────────────────────────────────────────────────────

assert(formalityRank({ id: "x", name: "Cocktail Dress", category: "full body" }) === 4, "cocktail dress ranks formal");
assert(formalityRank({ id: "x", name: "Grey Hoodie", category: "top" }) === 0, "hoodie ranks athletic");
assert(formalityRank({ id: "x", formality: "business", name: "Shirt", category: "top" }) === 3, "stored formality wins");
assert(formalityRank({ id: "x", name: "Blue Jeans", category: "bottom" }) === null, "jeans have no inferred rank");

// cocktail dress + hoodie: spread 4 → hoodie dropped
r = sanitizeOutfitSelection(["dress", "hoodie", "heels"], closet, []);
assert(r.includes("dress") && !r.includes("hoodie"), "cocktail dress + hoodie rejected in code");
// gym shorts + sports bra + heels: the clash can't be fixed by dropping the
// heels (that leaves the look shoeless), so the guard keeps the outfit intact
// and outfitStyleConflicts reports it for a regeneration retry instead.
const gymLook: StylistItem[] = [
  { id: "shorts", category: "bottom", name: "Gym Shorts", type: "shorts" },
  { id: "heels", category: "shoes", name: "Black Heels", type: "heels" },
  { id: "tank", category: "top", name: "Sports Bra Tank", type: "tank" },
];
const gymMix = dropFormalityOutliers(gymLook, new Set());
assert(gymMix.length === 3 && gymMix.some((i) => i.id === "heels"), "guard never strips the only shoes");
const gymConflicts = outfitStyleConflicts(gymLook);
assert(gymConflicts.length === 1 && /formality clash/.test(gymConflicts[0]), "unfixable heels clash reported for retry");
// when a droppable NON-shoe outlier exists the guard still trims it
const gymMix2 = dropFormalityOutliers(
  [
    { id: "shorts", category: "bottom", name: "Gym Shorts", type: "shorts" },
    { id: "tank", category: "top", name: "Sports Bra Tank", type: "tank" },
    { id: "blazer", category: "outerwear", name: "Tuxedo Blazer", type: "blazer" },
    { id: "sneakers", category: "shoes", name: "Running Sneakers", type: "sneakers" },
  ],
  new Set(),
);
assert(!gymMix2.some((i) => i.id === "blazer") && gymMix2.some((i) => i.id === "sneakers"), "non-shoe formality outlier still trimmed");

// ── color validator ──────────────────────────────────────────────────────────

const colorful: StylistItem[] = [
  { id: "a", category: "top", name: "Red Top", color: "red" },
  { id: "b", category: "bottom", name: "Green Pants", color: "green" },
  { id: "c", category: "accessory", name: "Purple Scarf Thing", color: "purple" },
  { id: "d", category: "shoes", name: "White Sneakers", color: "white" },
];
const colorTrimmed = dropColorClashes(colorful, new Set());
assert(!colorTrimmed.some((i) => i.id === "c"), "third accent accessory trimmed");
assert(colorTrimmed.some((i) => i.id === "a") && colorTrimmed.some((i) => i.id === "b"), "core garments never color-trimmed");
const twoAccents = dropColorClashes(colorful.slice(0, 2), new Set());
assert(twoAccents.length === 2, "two accents allowed untouched");

// red top + green pants + purple shoes: three accent CORE garments — nothing
// is trimmable, so the conflict must be reported for a regeneration retry.
const tripleAccentCore: StylistItem[] = [
  { id: "a", category: "top", name: "Red Top", color: "red" },
  { id: "b", category: "bottom", name: "Green Pants", color: "green" },
  { id: "e", category: "shoes", name: "Purple Shoes", color: "purple" },
];
assert(dropColorClashes(tripleAccentCore, new Set()).length === 3, "core accent trio survives trimming");
assert(outfitStyleConflicts(tripleAccentCore).some((c) => /color clash/.test(c)), "core accent trio reported for retry");
assert(outfitStyleConflicts(colorTrimmed).length === 0, "trimmed outfit reports no conflicts");

// ── pattern validator ────────────────────────────────────────────────────────

const patterned: StylistItem[] = [
  { id: "p1", category: "top", name: "Floral Blouse", pattern: "floral" },
  { id: "p2", category: "accessory", name: "Leopard Scarf", pattern: "animal" },
  { id: "p3", category: "bottom", name: "Plain Jeans", pattern: "solid" },
];
const patTrimmed = dropPatternOverload(patterned, new Set());
assert(!patTrimmed.some((i) => i.id === "p2"), "second patterned accessory trimmed");
assert(patTrimmed.some((i) => i.id === "p1"), "first statement piece kept");

// floral top + plaid pants: two patterned CORE pieces — untrimmable, reported.
const doublePatternCore: StylistItem[] = [
  { id: "f1", category: "top", name: "Floral Top", pattern: "floral" },
  { id: "f2", category: "bottom", name: "Plaid Pants", pattern: "plaid" },
];
assert(dropPatternOverload(doublePatternCore, new Set()).length === 2, "patterned core duo survives trimming");
assert(outfitStyleConflicts(doublePatternCore).some((c) => /pattern overload/.test(c)), "patterned core duo reported for retry");

// ── layering order ───────────────────────────────────────────────────────────

const layered = orderOutfitLayers([
  { id: "coat", category: "outerwear", name: "Coat" },
  { id: "tank", category: "top", name: "Black Tank", type: "tank" },
  { id: "sweater", category: "top", name: "Knit Sweater", type: "sweater" },
  { id: "jeans", category: "bottom", name: "Jeans" },
  { id: "shoes", category: "shoes", name: "Sneakers" },
]).map((i) => i.id);
assert(
  layered.indexOf("tank") < layered.indexOf("sweater") &&
    layered.indexOf("sweater") < layered.indexOf("coat"),
  "base -> mid -> outer ordering",
);
assert(layered.indexOf("coat") < layered.indexOf("jeans"), "garments before bottoms/shoes");
assert(layerRank({ id: "x", category: "outerwear" }) > layerRank({ id: "y", category: "top", name: "tee" }), "outerwear outermost");

// ── batch dedupe ─────────────────────────────────────────────────────────────

const batch = [
  { item_ids: ["tee", "jeans", "sneakers", "bag"] },
  { item_ids: ["tee", "jeans", "sneakers"] }, // 3/4 overlap = 75% → dup
  { item_ids: ["dress", "heels", "bag"] },
];
assert(dropNearDuplicateOutfits(batch, []).length === 2, "near-duplicate outfit dropped");
assert(outfitOverlap(["a", "b"], ["a", "b"]) === 1, "identical overlap = 1");
assert(outfitOverlap(["a", "b"], ["c", "d"]) === 0, "disjoint overlap = 0");
assert(isNearDuplicateOutfit(["a", "b", "c"], [["a", "b", "c", "d"]]), "isNearDuplicate detects 75%");
assert(!isNearDuplicateOutfit(["a", "x", "y"], [["a", "b", "c", "d"]]), "low overlap not dup");

// ── weather decode ───────────────────────────────────────────────────────────

const w1 = describeWeatherForStylist({ current_weather: { temperature: 88.2, weathercode: 0 } });
assert(!!w1 && w1.tempF === 88 && /clear/.test(w1.line), "current_weather shape decoded");
const w2 = describeWeatherForStylist({
  current: { temperature_2m: 41.7, weather_code: 63 },
  daily: { temperature_2m_max: [45], temperature_2m_min: [38], precipitation_probability_max: [80] },
});
assert(!!w2 && w2.tempF === 42 && w2.wet && /rain/.test(w2.line) && /80%/.test(w2.line), "current shape decoded w/ rain + precip");
assert(describeWeatherForStylist(undefined) === null, "no weather -> null");

// ── occasion mapping + filtering ─────────────────────────────────────────────

assert(occasionTagForPhrase("Dinner with Jenny") === "going-out", "dinner -> going-out");
assert(occasionTagForPhrase("Polished workplace style") === "work", "workplace -> work");
assert(occasionTagForPhrase("gym session") === "active", "gym -> active");
assert(occasionTagForPhrase("Wedding guest") === "formal", "wedding -> formal");
assert(occasionTagForPhrase("airport travel day") === "travel", "airport -> travel");
assert(occasionTagForPhrase("cozy movie night") === "lounge", "cozy -> lounge");
assert(occasionTagForPhrase("brunch with friends") === "casual", "brunch -> casual");
assert(occasionTagForPhrase("A creative fashion-forward mix") === null, "surprise -> null");

const mk = (id: string, category: string, occs: string[], extra: Partial<StylistItem> = {}): StylistItem => ({
  id,
  category,
  occasions: occs,
  name: id,
  ...extra,
});
const bigCloset = [
  mk("t1", "top", ["work", "casual"]), mk("t2", "top", ["work"]),
  mk("t3", "top", ["casual"]), mk("b1", "bottom", ["work", "casual"]),
  mk("b2", "bottom", ["work"]), mk("s1", "shoes", ["work"]),
  mk("s2", "shoes", ["casual"]), mk("o1", "outerwear", ["work"]),
  mk("a1", "accessory", ["work"]), mk("g1", "bag", ["work"]),
  mk("party1", "top", ["going-out"]), mk("party2", "bottom", ["going-out"]),
];
let occ = filterClosetByOccasion(bigCloset, "Polished workplace style", []);
assert(occ.applied, "work filter applies with coverage");
assert(!occ.items.some((i) => i.id === "party1"), "going-out top excluded from work pool");
occ = filterClosetByOccasion(bigCloset, "Polished workplace style", ["party1"]);
assert(occ.items.some((i) => i.id === "party1"), "anchor kept despite wrong occasion");
occ = filterClosetByOccasion(bigCloset, "whatever", [], "work");
assert(occ.applied, "tagOverride drives filtering (server key path)");
const smallCloset = [
  mk("t1", "top", ["work"]), mk("b1", "bottom", ["work"]), mk("s1", "shoes", ["work"]),
  mk("x1", "top", ["casual"]), mk("x2", "bottom", ["casual"]), mk("x3", "shoes", ["casual"]),
];
occ = filterClosetByOccasion(smallCloset, "work meeting", []);
assert(!occ.applied && occ.items.length === 6, "small closet skips hard filter");

// ── user style matching + enforcement ────────────────────────────────────────

const styledCloset = [
  mk("st1", "top", [], { style: "street", style_tags: ["street"], name: "Baggy Graphic Tee" }),
  mk("st2", "bottom", [], { style: "street", style_tags: ["street"], name: "Cargo Jeans" }),
  mk("st3", "shoes", [], { style: "street", style_tags: ["street"], name: "Chunky Sneakers" }),
  mk("pl1", "top", [], { style: "romantic", name: "Floral Summer Dress Top" }),
  mk("pl2", "bottom", [], { style: "office", name: "Pleated Trousers" }),
  mk("pl3", "shoes", [], { style: "office", name: "Loafers" }),
  mk("pl4", "top", [], { style: "minimalist", name: "White Tee" }),
];
let ms = userStyleMatchIds(styledCloset, "y2k streetwear looks please");
assert(!!ms && ms.has("st1") && ms.has("st2") && ms.has("st3"), "streetwear matches street-tagged items");
assert(!!ms && !ms.has("pl1"), "summer dress does NOT match streetwear ask");
ms = userStyleMatchIds(styledCloset, "Prioritize tonal color harmony. User direction: street style fits");
assert(!!ms && ms.has("st1") && !ms.has("pl2"), "only user segment tokenized");
assert(userStyleMatchIds(styledCloset, "romantic vibes") === null, "fewer than 3 matches -> null");
assert(userStyleMatchIds(styledCloset, "") === null, "empty instructions -> null");

const matchSet = new Set(["st1", "st2", "st3"]);
assert(outfitHonorsUserStyle(["st1", "st2", "jeans"], matchSet), "2 matches honors (required 2)");
assert(!outfitHonorsUserStyle(["st1", "jeans", "shoes"], matchSet), "1 match does NOT honor when 2 required");
const enforced = enforceUserStyleMatch(
  [
    { item_ids: ["st1", "st2", "sneakers"] },
    { item_ids: ["pl1", "pl2", "pl3"] },
  ],
  matchSet,
);
assert(enforced.length === 1 && enforced[0].item_ids.includes("st1"), "non-honoring outfit dropped");
assert(
  enforceUserStyleMatch([{ item_ids: ["pl1", "pl2"] }], matchSet).length === 0,
  "returns EMPTY when nothing honors (no silent fallback)",
);

// ── rotation ─────────────────────────────────────────────────────────────────

const recent = recentlySuggestedIds([["a", "b"], ["c"], ["d"], ["e"], ["f"], ["g"], ["ignored-too-old"]], 6);
assert(recent.has("a") && recent.has("g") && !recent.has("ignored-too-old"), "recent window respects depth");
const rotated = rotationSortForPrompt(
  [
    { id: "old-fav", wear_count: 9 },
    { id: "fresh", wear_count: 0 },
    { id: "recent-pick", wear_count: 0 },
  ],
  new Set(["recent-pick"]),
);
assert(rotated[rotated.length - 1].id === "recent-pick", "recently-suggested sorts last");
assert(rotated[0].id === "fresh", "least-worn non-recent sorts first");

// ── classification guards ────────────────────────────────────────────────────

assert(isLikelyNonWardrobeObject({ name: "Green Bird", category: "accessory" }), "bird blocked");
assert(isLikelyNonWardrobeObject({ name: "House Plant", category: "accessory" }), "plant blocked");
assert(isLikelyNonWardrobeObject({ name: "Throw Pillow", category: "accessory" }), "pillow blocked");
assert(!isLikelyNonWardrobeObject({ name: "Animal Print Blouse", category: "top" }), "animal print blouse kept");
assert(!isLikelyNonWardrobeObject({ name: "Cat-Eye Sunglasses", category: "accessory" }), "cat-eye sunglasses kept");
assert(!isLikelyNonWardrobeObject({ name: "Dog Graphic Tee", category: "top" }), "dog graphic tee kept");
assert(!isLikelyNonWardrobeObject({ name: "Blanket Scarf", category: "accessory" }), "blanket scarf kept");
assert(!isLikelyNonWardrobeObject({ name: "Turtleneck Sweater", category: "top" }), "turtleneck kept");
assert(!isLikelyNonWardrobeObject({ name: "Fishnet Tights", category: "accessory" }), "fishnet tights kept");
assert(!isLikelyNonWardrobeObject({ name: "Coffee Brown Hoodie", category: "top" }), "coffee brown hoodie kept");

assert(isLowConfidenceClassification({ confidence: 0.42 }), "0.42 flagged low");
assert(!isLowConfidenceClassification({ confidence: 0.9 }), "0.9 not flagged");
assert(isLowConfidenceClassification({}), "missing confidence treated as low");
assert(isLowConfidenceClassification({ confidence: "high" }), "non-numeric confidence treated as low");

// ── classify metadata normalisation ──────────────────────────────────────────

assert(
  JSON.stringify(normalizeStyleTags(["Street", "EDGY", "bogus", "street"])) === JSON.stringify(["street", "edgy"]),
  "style tags whitelisted, deduped, lowercased",
);
assert(normalizePattern("Floral") === "floral", "pattern normalized");
assert(normalizePattern("weird-thing") === "solid", "unknown pattern -> solid");
assert(normalizeFormality("Smart Casual") === "smart-casual", "formality normalized");
assert(normalizeFormality("banana") === null, "unknown formality -> null");
assert(primaryStyleFromTags(["street", "edgy"]) === "street", "primary style = first tag");
assert(primaryStyleFromTags([]) === "casual", "no tags -> casual fallback");

// ── request-level Gemini call budget ─────────────────────────────────────────

// No budget → never throttles (preserves per-attempt-only bounding).
for (let i = 0; i < 50; i++) spendCallBudget(undefined);
assert(true, "undefined budget never throttles");

// A budget permits exactly `max` logical calls, then throws.
const b1: StylistCallBudget = { used: 0, max: 3 };
spendCallBudget(b1);
spendCallBudget(b1);
spendCallBudget(b1);
assert(b1.used === 3, "budget counts each spent call");
let threw = false;
try {
  spendCallBudget(b1);
} catch (e) {
  threw = e instanceof StylistCallBudgetExhausted;
}
assert(threw, "budget throws StylistCallBudgetExhausted once max is reached");
assert(b1.used === 3, "exhausted budget is not incremented past max");

// A SINGLE shared budget is drained across separate call sites (bulk + refill
// share one object): simulate a bulk fn spending 2, then a refill fn spending
// from what's left of an N+2-capped 5-look request (max 7).
const shared: StylistCallBudget = { used: 0, max: 7 };
const bulk = () => {
  spendCallBudget(shared); // first bulk attempt
  spendCallBudget(shared); // its one conflict/style retry
};
const refillOnce = () => {
  spendCallBudget(shared); // one refill attempt
};
bulk();
assert(shared.used === 2, "bulk consumes from the shared budget");
let refills = 0;
try {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    refillOnce();
    refills += 1;
  }
} catch (e) {
  assert(e instanceof StylistCallBudgetExhausted, "refill loop stops on exhaustion");
}
assert(shared.used === 7 && refills === 5, "shared budget caps total calls at max across bulk+refill");

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
