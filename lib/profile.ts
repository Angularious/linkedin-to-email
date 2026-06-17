// Shared profile shape + merge, used by both the API route (merging providers
// within a phase) and the client (accumulating across phases). Kept in one place
// so the field set and the merge semantics can't drift between the two.

export interface Profile {
  name?: string
  title?: string
  headline?: string
  location?: string
  company?: string
  companyLogo?: string
  companySize?: string
  companyIndustry?: string
  photoUrl?: string
}

// Merge partial profiles in priority order: the first source with a value for a
// given field wins. Lets Apollo supply the photo while Ocean fills the company
// card and Bytemine backfills anything still missing. Returns undefined when
// every part is empty.
export function mergeProfiles(...parts: Array<Profile | undefined>): Profile | undefined {
  const merged: Profile = {}
  for (const p of parts) {
    if (!p) continue
    for (const k of Object.keys(p) as (keyof Profile)[]) {
      if (merged[k] === undefined && p[k] !== undefined) merged[k] = p[k]
    }
  }
  return Object.keys(merged).length ? merged : undefined
}
